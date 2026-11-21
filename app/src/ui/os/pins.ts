/**
 * The city pins and the lock-on (Task 10): while a screen is open over the city, one set of labels names the
 * towers. Each district with items waiting gets a numbered amber pin over its tower; every other standing district
 * gets a quiet one, a small tick and its name, dim, never numbered and never lifted. The active item (the hovered
 * or focused row, or else the first target, which the caller decides) gets a lock round its tower and a leader
 * from its row's rail to the ring at the tower's head, routed in right angles round every pin, tag and the
 * telemetry. The city's own plates fade while the pins show (pins.css) and come back when they go.
 *
 * Each frame, from the city's frame hook, every read comes first and every write after:
 *   - the towers' frames and the districts are read again every REFRESH frames, a tag's size once after it lays
 *     out, the pane's edge on show and resize, and the active row's middle only when the list scrolls, the
 *     active item changes or the list's layout moves the row (the faces arriving, a resize);
 *   - the lock is placed before the pins, so they lift clear of its tag; the leader is routed only when the key
 *     of everything it avoids changes by a pixel;
 *   - writes are transforms, a custom property when a tag lifts, and classes, each only when it changes.
 *
 * Where a tower has no frame (not built, or mid-rebuild), stands behind the eye or off the pane, it has no pin; a
 * locked tower off the pane has no lock; a row scrolled out of the list has no leader, and the lock stays; where
 * no route is clear, no leader is drawn. Red is the grant's and the lock's on the grant alone. Every word is set
 * with textContent.
 */
import * as THREE from 'three';

import { projectToView } from '../../city/labels.js';
import { lockGeometry, lockTagBox, pinLabel, placePins, tagCustomProperties, type LockAt, type PinCandidate, type Projected, type View } from './pin-layout.js';
import { routeLeader, routePath, type Box } from './route.js';
import type { Tone } from './tokens.js';

/** The city under the pins: its camera, where a tower stands, a hook run every frame after the plates, and what stands. */
export interface OsCity {
  camera: THREE.Camera;
  towerFrame(repo: string): { center: THREE.Vector3; width: number; height: number } | null;
  onFrame(fn: () => void): () => void;
  /** The repos of the districts standing now (the city's last occupancy). */
  districts(): string[];
}

/** One item the pins track: its number in the list, its district, the district's short name and its figure. */
export interface PinTarget {
  id: string;
  n: number;
  repo: string;
  name: string;
  figure: string;
  tone: Tone | 'ask' | 'grant';
}

export interface OsPins {
  show(): void;
  hide(): void;
  setTargets(t: PinTarget[]): void;
  /** The item locked on, and its row: the leader leaves from the row's middle. Null takes the lock down. */
  setActive(id: string | null, row: HTMLElement | null): void;
}

type Frame = { center: THREE.Vector3; width: number; height: number };

const SVG_NS = 'http://www.w3.org/2000/svg';
const pad2 = (n: number): string => String(n).padStart(2, '0');

/** The ring at the lock's head: drawn `d` across; the leader ends `reach` from its centre, on its stroke. */
const RING = Object.freeze({ d: 36, reach: 21 });
/** The box the ring keeps for itself, from its centre: no pin's tag stands on it. */
const RING_KEEP = 22;
/** How often the towers' frames and the districts are read again, in frames. */
const REFRESH = 90;
/**
 * The router's budget, so a layout with no way through cannot hitch a frame, and the most points a leader has:
 * five (rail, stub, channel, the tower's line, the ring). A seven-point detour zigzags through the sky and reads
 * as noise; where only one would do, the lock alone names the tower (critique, Task 10).
 */
const ROUTE_LIMITS = Object.freeze({ maxConsiders: 20_000, maxPoints: 5 });
/** The leader leaves a row this far below its top at most: the middle of a short row, the headline of a tall one. */
const ROW_MID_MAX = 34;
/** A row this near the list's edge counts as scrolled out. */
const ROW_EDGE = 8;
/** The leader's channels keep this far below the pane top and above the window's foot. */
const CHANNEL = Object.freeze({ top: 18, foot: 30 });
/** The leader leaves from the panel's rail, this far right of its edge. */
const RAIL = 2;

/** How many pin sets are showing: the plates come back only when none is. */
let showing = 0;

interface Pin {
  repo: string;
  quiet: boolean;
  targets: PinTarget[];
  /** What the pin was last drawn from, so a change redraws it and nothing else does (null: never drawn). */
  sig: string | null;
  el: HTMLElement;
  tag: HTMLElement;
  frame: Frame | null;
  /** Where its tower's head projects this frame, and its candidate for placement (its tag's size, 0 until read). */
  at: Projected;
  cand: PinCandidate;
  shown: boolean;
  locked: boolean;
  lift: number;
  x: number;
  y: number;
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] => {
  const n = document.createElement(tag);
  n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

const svg = (tag: string, cls: string): SVGElement => {
  const n = document.createElementNS(SVG_NS, tag) as SVGElement;
  n.setAttribute('class', cls);
  return n;
};

const shortName = (repo: string): string => repo.split('/').pop() || repo;
const translate = (x: number, y: number): string => `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
/** Rounded to a tenth of a pixel, so a write happens only when something moved enough to see. */
const tenth = (v: number): number => Math.round(v * 10) / 10;

export function createPins(parent: HTMLElement, panel: HTMLElement, scroller: HTMLElement, city: OsCity | undefined): OsPins {
  const root = el('div', 'os-pins');
  root.setAttribute('aria-hidden', 'true');
  root.hidden = true;
  for (const [k, v] of Object.entries(tagCustomProperties())) root.style.setProperty(k, v);
  root.style.setProperty('--os-lock-ring-d', `${RING.d}px`);

  // The pane's frame: the telemetry at its foot, which the leader keeps clear of.
  const frameEl = el('div', 'os-pins-frame');
  const tele = el('div', 'os-pins-tele os-figs', 'track 00');
  frameEl.append(tele);

  // The leader: a soft glow under a hairline, and a dot where it meets the ring.
  const lines = svg('svg', 'os-pins-lines');
  const glow = svg('path', 'os-leader-glow');
  const leader = svg('path', 'os-leader');
  const dot = svg('circle', 'os-leader-dot');
  dot.setAttribute('r', '2.5');
  lines.append(glow, leader, dot);

  const set = el('div', 'os-pins-set');

  // The lock: four brackets that close on the tower, the ring at its head, and its tag. Each part is placed by
  // its own transform, so the lock moves without layout.
  const lock = el('div', 'os-lock');
  const corners = (['tl', 'tr', 'bl', 'br'] as const).map((c) => {
    const at = el('span', `os-lock-c ${c}`);
    at.append(el('i', 'os-lock-l'));
    lock.append(at);
    return at;
  });
  const ring = el('span', 'os-lock-ring');
  const lockTag = el('div', 'os-lock-tag');
  const lockN = el('span', 'os-lock-n os-figs');
  const lockName = el('span', 'os-lock-name');
  const lockFig = el('span', 'os-lock-fig os-figs');
  lockTag.append(lockN, lockName, lockFig);
  lock.append(ring, lockTag);

  root.append(frameEl, lines, set, lock);
  parent.append(root);

  let shown = false;
  let unhook: (() => void) | null = null;
  let targets: PinTarget[] = [];
  let pins: Pin[] = [];
  const byRepo = new Map<string, Pin>();
  let cands: PinCandidate[] = [];
  /** The districts as last read, and their key: districts() allocates, so it is read only at a refresh. */
  let districts: string[] | null = null;
  let districtsKey = '';

  let active: PinTarget | null = null;
  let activeRow: HTMLElement | null = null;
  /** What the lock last showed, and whose lock it was: a new id closes the brackets in again. */
  let activeKey = '';
  let activeId = '';
  let acquireTurn = false;

  let frames = 0;
  let framesDirty = true;
  let sizesDirty = true;
  let measureDirty = true;
  let teleDirty = false;
  let rowDirty = true;
  let buildDirty = false;

  const view: View = { w: 0, h: 0, left: 0 };
  let paneTop = 0;
  let paneLeftWritten = -1;
  let teleBox: Box | null = null;
  let rowY: number | null = null;

  // What was last written, so a still frame writes nothing.
  let lockOn = false;
  let lockFlip = false;
  const lockWas = { x: NaN, top: NaN, base: NaN, half: NaN, tx: NaN, ty: NaN };
  let linesOn = false;
  let routeKey: number[] = [];
  const keyNow: number[] = [];
  const avoid: Box[] = [];
  const reserved: Box[] = [];

  const head = { x: 0, y: 0, behind: false };
  const foot = { x: 0, y: 0, behind: false };
  const point = new THREE.Vector3();
  const scratch = new THREE.Vector3();
  /** Whether the last route found a way. */
  let routed = false;

  const rowMoved = (): void => {
    rowDirty = true;
  };
  scroller.addEventListener('scroll', rowMoved, { passive: true });
  // The list's layout moves the row without a scroll: the faces arriving, the head growing, a row reflowing.
  const sized = typeof ResizeObserver === 'function' ? new ResizeObserver(rowMoved) : null;
  sized?.observe(scroller);
  const fonts = typeof document.fonts?.addEventListener === 'function' ? document.fonts : null;

  /** Draws a pin's tag from its targets (or its name alone, quiet). Words by textContent. */
  function draw(pin: Pin): void {
    pin.el.classList.toggle('quiet', pin.quiet);
    pin.el.classList.toggle('grant', pin.targets.some((t) => t.tone === 'grant'));
    if (pin.quiet) delete pin.el.dataset.tone;
    else pin.el.dataset.tone = pin.targets[0].tone;
    const tag = el('span', 'os-pin-tag');
    if (pin.quiet) tag.append(el('span', 'os-pin-name', shortName(pin.repo)));
    else {
      const lead = pin.targets[0];
      tag.append(el('span', 'os-pin-n os-figs', pinLabel(pin.targets.map((t) => t.n))), el('span', 'os-pin-name', lead.name), el('span', 'os-pin-fig os-figs', lead.figure));
    }
    pin.el.replaceChildren(el('span', 'os-pin-mark'), tag);
    pin.tag = tag;
    pin.cand.w = 0;
    pin.cand.h = 0;
    sizesDirty = true;
  }

  function newPin(repo: string): Pin {
    const box = el('div', 'os-pin');
    box.dataset.repo = repo;
    const tag = el('span', 'os-pin-tag');
    const at = { x: 0, y: 0, behind: false };
    return { repo, quiet: true, targets: [], sig: null, el: box, tag, frame: null, at, cand: { repo, quiet: true, locked: false, at: null, w: 0, h: 0 }, shown: false, locked: false, lift: 0, x: NaN, y: NaN };
  }

  /** One pin per standing district: those with targets first, in item order, then the quiet ones. */
  function build(): void {
    buildDirty = false;
    const repos = districts ?? [];
    const standing = new Set(repos);
    const waiting = new Map<string, PinTarget[]>();
    for (const t of [...targets].sort((a, b) => a.n - b.n)) {
      if (!standing.has(t.repo)) continue;
      const list = waiting.get(t.repo);
      if (list) list.push(t);
      else waiting.set(t.repo, [t]);
    }
    const order = [...waiting.keys(), ...repos.filter((r) => !waiting.has(r))];
    const next: Pin[] = [];
    const gone = new Map(byRepo);
    byRepo.clear();
    for (const repo of order) {
      const pin = gone.get(repo) ?? newPin(repo);
      gone.delete(repo);
      const ts = waiting.get(repo) ?? [];
      pin.targets = ts;
      pin.quiet = ts.length === 0;
      pin.cand.quiet = pin.quiet;
      const sig = pin.quiet ? '' : ts.map((t) => `${t.id}\u0001${t.n}\u0001${t.name}\u0001${t.figure}\u0001${t.tone}`).join('\u0002');
      if (sig !== pin.sig) {
        pin.sig = sig;
        draw(pin);
      }
      byRepo.set(repo, pin);
      next.push(pin);
    }
    for (const pin of gone.values()) pin.el.remove();
    set.replaceChildren(...next.map((p) => p.el));
    pins = next;
    cands = next.map((p) => p.cand);
    let tracked = 0;
    for (const [, ts] of waiting) tracked += ts.length;
    tele.textContent = `track ${pad2(tracked)}`;
    framesDirty = true;
    drawActive();
  }

  /** The lock's words and colour, and its brackets closing in, when the active item changes. */
  function drawActive(): void {
    const on = !!active && byRepo.has(active.repo);
    const key = on ? `${active!.id}\u0001${active!.n}\u0001${active!.name}\u0001${active!.figure}\u0001${active!.tone}` : '';
    if (key === activeKey) return;
    activeKey = key;
    const newLock = on && active!.id !== activeId;
    activeId = on ? active!.id : '';
    const grant = on && active!.tone === 'grant';
    lock.classList.toggle('grant', grant);
    lines.classList.toggle('grant', grant);
    lockN.textContent = on ? pad2(active!.n) : '';
    lockName.textContent = on ? active!.name : '';
    lockFig.textContent = on ? active!.figure : '';
    if (newLock) {
      // Two names for the one animation, so a new lock restarts it without a forced layout.
      acquireTurn = !acquireTurn;
      lock.classList.remove(acquireTurn ? 'acquire-b' : 'acquire-a');
      lock.classList.add(acquireTurn ? 'acquire-a' : 'acquire-b');
    }
    routeKey = [];
  }

  /** The reads of a frame. */
  function read(): void {
    if (!city) return;
    if (measureDirty) {
      measureDirty = false;
      // offsetLeft and offsetWidth ignore transforms, so the panel's slide and lean do not move the pane's edge.
      view.left = Math.round(panel.offsetLeft + panel.offsetWidth);
      view.w = window.innerWidth;
      view.h = window.innerHeight;
      paneTop = frameEl.offsetTop;
      teleBox = null;
    } else if (teleDirty) {
      // The frame after the pane's edge was written, so the telemetry's box is where it now stands.
      teleDirty = false;
      const r = tele.getBoundingClientRect();
      teleBox = r.width > 0 ? { x0: r.left, y0: r.top, x1: r.right, y1: r.bottom } : null;
    }
    if (frames % REFRESH === 0 || framesDirty) {
      const ds = city.districts();
      const key = ds.join('\n');
      if (key !== districtsKey || districts === null) {
        districtsKey = key;
        districts = ds;
        buildDirty = true;
      }
      if (!buildDirty) {
        framesDirty = false;
        for (const pin of pins) pin.frame = city.towerFrame(pin.repo);
      }
    }
    frames++;
    if (sizesDirty) {
      sizesDirty = false;
      for (const pin of pins) {
        if (pin.cand.w) continue;
        pin.cand.w = pin.tag.offsetWidth;
        pin.cand.h = pin.tag.offsetHeight;
      }
    }
    if (rowDirty) {
      rowDirty = false;
      const r = activeRow?.isConnected ? activeRow.getBoundingClientRect() : null;
      const list = scroller.getBoundingClientRect();
      const y = r ? r.top + Math.min(r.height / 2, ROW_MID_MAX) : null;
      // A row scrolled out of the list has no leader: the lock stays, the line waits for the row.
      rowY = y !== null && y > list.top + ROW_EDGE && y < list.bottom - ROW_EDGE ? y : null;
    }
  }

  const project = (f: Frame, dy: number, out: Projected): Projected => {
    point.set(f.center.x, f.center.y + dy, f.center.z);
    return projectToView(point, city!.camera, view.w, view.h, out, scratch);
  };

  /** One frame: every read, then the placing, then every write. */
  function tick(): void {
    if (!shown || !city) return;
    read();
    if (buildDirty) {
      // What stands has changed: the pins are rebuilt now and placed from the next frame, once their frames are read.
      build();
      return;
    }

    // The lock first, so the pins stand clear of its tag and ring.
    const lockPin = active ? byRepo.get(active.repo) : undefined;
    let at: LockAt | null = null;
    if (lockPin?.frame) {
      const f = lockPin.frame;
      at = lockGeometry(project(f, f.height / 2, head), project(f, -f.height / 2, foot), f, view);
    }
    reserved.length = 0;
    let tagBox: Box | null = null;
    let flip = false;
    if (at) {
      const t = lockTagBox(at, view, paneTop);
      tagBox = t.box;
      flip = t.flip;
      reserved.push(tagBox, { x0: at.x - RING_KEEP, x1: at.x + RING_KEEP, y0: at.top - RING_KEEP, y1: at.top + RING_KEEP });
    }

    for (const pin of pins) {
      pin.cand.locked = !!at && pin === lockPin;
      pin.cand.at = pin.frame && pin.cand.w ? project(pin.frame, pin.frame.height / 2, pin.at) : null;
    }
    const placed = placePins(cands, reserved, view);

    avoid.length = 0;
    if (teleBox) avoid.push(teleBox);
    if (tagBox) avoid.push(tagBox);
    for (const p of placed) if (p.box) avoid.push(p.box);

    // The leader, routed again only when its key moves by a pixel.
    let route = false;
    let pts: ReturnType<typeof routeLeader> = null;
    const leaderWanted = !!at && rowY !== null;
    if (at && rowY !== null) {
      const x0 = view.left + RAIL;
      const y0 = Math.round(Math.min(Math.max(rowY, paneTop + CHANNEL.top), view.h - CHANNEL.foot));
      keyNow.length = 0;
      keyNow.push(x0, y0, Math.round(at.x), Math.round(at.top), view.h);
      for (const b of avoid) keyNow.push(Math.round(b.x0), Math.round(b.y0), Math.round(b.x1), Math.round(b.y1));
      if (keyNow.length !== routeKey.length || keyNow.some((v, i) => v !== routeKey[i])) {
        routeKey = keyNow.slice();
        route = true;
        pts = routeLeader({ x: x0, y: y0 }, { x: Math.round(at.x), y: Math.round(at.top), r: RING.reach }, avoid, paneTop + CHANNEL.top, view.h - CHANNEL.foot, ROUTE_LIMITS);
      }
    }

    // Writes.
    if (paneLeftWritten !== view.left) {
      paneLeftWritten = view.left;
      root.style.setProperty('--os-pane-left', `${view.left}px`);
      teleDirty = true;
    }
    for (let i = 0; i < pins.length; i++) {
      const pin = pins[i];
      const p = placed[i];
      if (p.shown) {
        const x = tenth(pin.at.x);
        const y = tenth(pin.at.y);
        if (x !== pin.x || y !== pin.y) {
          pin.x = x;
          pin.y = y;
          pin.el.style.transform = translate(x, y);
        }
        if (p.lift !== pin.lift) {
          pin.lift = p.lift;
          pin.el.style.setProperty('--os-pin-lift', `${p.lift}px`);
        }
      }
      if (p.shown !== pin.shown) {
        pin.shown = p.shown;
        pin.el.classList.toggle('on', p.shown);
      }
      if (pin.cand.locked !== pin.locked) {
        pin.locked = pin.cand.locked;
        pin.el.classList.toggle('locked', pin.locked);
      }
    }

    if (at && tagBox) {
      if (!lockOn) {
        lockOn = true;
        lock.classList.add('on');
      }
      const x = tenth(at.x);
      const top = tenth(at.top);
      const base = tenth(at.base);
      const half = tenth(at.half);
      if (x !== lockWas.x || top !== lockWas.top || base !== lockWas.base || half !== lockWas.half) {
        lockWas.x = x;
        lockWas.top = top;
        lockWas.base = base;
        lockWas.half = half;
        corners[0].style.transform = translate(x - half, top);
        corners[1].style.transform = translate(x + half, top);
        corners[2].style.transform = translate(x - half, base);
        corners[3].style.transform = translate(x + half, base);
        ring.style.transform = translate(x, top);
      }
      const tx = tenth(tagBox.x0);
      const ty = tenth(tagBox.y0);
      if (tx !== lockWas.tx || ty !== lockWas.ty) {
        lockWas.tx = tx;
        lockWas.ty = ty;
        lockTag.style.transform = translate(tx, ty);
      }
      if (flip !== lockFlip) {
        lockFlip = flip;
        lock.classList.toggle('flip', flip);
      }
    } else if (lockOn) {
      lockOn = false;
      lock.classList.remove('on');
    }

    if (route) {
      if (pts) {
        const d = routePath(pts);
        leader.setAttribute('d', d);
        glow.setAttribute('d', d);
        const end = pts[pts.length - 1];
        dot.setAttribute('cx', end[0].toFixed(1));
        dot.setAttribute('cy', end[1].toFixed(1));
      }
      routed = !!pts;
    }
    const on = leaderWanted && routed;
    if (on !== linesOn) {
      linesOn = on;
      lines.classList.toggle('on', on);
    }
  }

  const onResize = (): void => {
    measureDirty = true;
    rowDirty = true;
  };

  return {
    show() {
      if (shown) return;
      shown = true;
      root.hidden = false;
      measureDirty = true;
      framesDirty = true;
      sizesDirty = true;
      rowDirty = true;
      routeKey = [];
      window.addEventListener('resize', onResize);
      fonts?.addEventListener('loadingdone', rowMoved);
      if (!city) return;
      // One set of labels: the city's own plates fade while the pins name the towers (pins.css).
      if (showing++ === 0) document.documentElement.dataset.osPins = 'on';
      unhook = city.onFrame(tick);
    },
    hide() {
      if (!shown) return;
      shown = false;
      root.hidden = true;
      window.removeEventListener('resize', onResize);
      fonts?.removeEventListener('loadingdone', rowMoved);
      if (unhook) {
        unhook();
        unhook = null;
        if (--showing === 0) delete document.documentElement.dataset.osPins;
      }
      // Nothing stays drawn to flash at its old place when they show again.
      for (const pin of pins) {
        pin.shown = false;
        pin.el.classList.remove('on');
      }
      lockOn = false;
      lock.classList.remove('on');
      linesOn = false;
      lines.classList.remove('on');
    },
    setTargets(t) {
      targets = t.slice();
      if (active) active = targets.find((x) => x.id === active!.id) ?? null;
      if (city && districts === null) {
        districts = city.districts();
        districtsKey = districts.join('\n');
      }
      build();
    },
    setActive(id, row) {
      const t = id ? targets.find((x) => x.id === id) ?? null : null;
      if (t !== active || row !== activeRow) rowDirty = true;
      if (sized && row !== activeRow) {
        if (activeRow) sized.unobserve(activeRow);
        if (t && row) sized.observe(row);
      }
      active = t;
      activeRow = t ? row : null;
      drawActive();
    },
  };
}
