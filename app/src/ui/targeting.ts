/**
 * Targeting (redesign direction C, a throwaway prototype): the HUD the Brief lays over the live city. Each item
 * with a district gets a readout pinned over its tower; the active item (hovered, focused, or else the first
 * that waits) gets a lock-on round its tower and a leader line from its row. A scan sweeps the city pane, and a
 * stream of the brief's own figures runs behind the list. Everything moves by transform or by an SVG path's
 * points, written once a frame from the city's own frame hook, and only while the Brief is open.
 */
import * as THREE from 'three';

import { projectToView } from '../city/labels';
import { el } from './controls';

/** The city under the HUD: its camera, where a tower stands, and a hook run every frame after the plates. */
export interface HudCity {
  camera: THREE.Camera;
  towerFrame(repo: string): { center: THREE.Vector3; width: number; height: number } | null;
  onFrame(fn: () => void): () => void;
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
  el: HTMLElement;
  frame: { center: THREE.Vector3; width: number; height: number } | null;
  shown: boolean;
  /** How far its tag stands lifted to clear a pin placed before it, in pixels. */
  lift: number;
}

/** A pin's tag's reach to the right of its mark, for the collision test. */
const PIN_W = 170;
/** The lock's tag's width: past the window's right edge it stands left of the brackets instead. */
const LOCK_TAG_W = 200;

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

  function pinFor(repo: string, targets: Target[]): Pin {
    const box = el('div', 'tg-pin');
    return { repo, targets, el: box, frame: null, shown: false, lift: 0 };
  }

  function drawPin(pin: Pin): void {
    const lead = pin.targets[0];
    pin.el.dataset.tone = lead.tone;
    pin.el.classList.toggle('grant', pin.targets.some((t) => t.grant));
    const tag = el('span', 'tg-pin-tag');
    tag.append(el('span', 'tg-pin-n', pin.targets.map((t) => pad2(t.n)).join(' ')), el('span', 'tg-pin-name', lead.name), el('span', 'tg-pin-fig', lead.figure));
    pin.el.replaceChildren(el('span', 'tg-pin-mark'), tag);
  }

  function refreshFrames(): void {
    if (!city) return;
    for (const pin of live) pin.frame = city.towerFrame(pin.repo);
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
    const placed: Array<{ x0: number; x1: number; y0: number; y1: number }> = [];
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
          pin.el.style.transform = `translate3d(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px, 0)`;
          let lift = 0;
          const box = { x0: p.x, x1: p.x + PIN_W, y0: p.y - 52, y1: p.y + 4 };
          for (let k = 0; k < 4 && placed.some((o) => box.x0 < o.x1 && o.x0 < box.x1 && box.y0 - lift < o.y1 && o.y0 < box.y1 - lift); k++) lift += 50;
          placed.push({ x0: box.x0, x1: box.x1, y0: box.y0 - lift, y1: box.y1 - lift });
          if (pin.lift !== lift) {
            pin.lift = lift;
            pin.el.style.setProperty('--lift', `${lift}px`);
          }
        }
        if (active && pin.repo === active.repo && !p.behind && !q.behind) {
          const tall = Math.max(24, q.y - p.y);
          const half = Math.max(16, Math.min(70, (tall * f.width) / Math.max(1, f.height) / 2 + 10));
          if (p.x > left && p.x < w - 24) lockAt = { x: p.x, top: Math.max(78, p.y - 14), base: Math.min(h - 30, q.y + 6), half };
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
      const flip = lockAt.x + lockAt.half + 12 + LOCK_TAG_W > w - 28;
      if (flip !== lockFlipped) {
        lockFlipped = flip;
        lock.classList.toggle('flip', flip);
      }
      if (rowY !== null) {
        const y0 = Math.min(Math.max(rowY, 90), h - 30);
        const x0 = paneLeft + 2;
        // Out of the rail, a short run level, then straight to the ring at the tower's head: the line names the target.
        const knee = x0 + 28;
        const dx = lockAt.x - knee;
        const dy = lockAt.top - y0;
        const len = Math.max(1, Math.hypot(dx, dy));
        const x1 = lockAt.x - (dx / len) * 21;
        const y1 = lockAt.top - (dy / len) * 21;
        const d = `M${x0},${y0.toFixed(1)} H${knee.toFixed(1)} L${x1.toFixed(1)},${y1.toFixed(1)}`;
        leader.setAttribute('d', d);
        glow.setAttribute('d', d);
        leaderDot.setAttribute('cx', x1.toFixed(1));
        leaderDot.setAttribute('cy', y1.toFixed(1));
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
      window.removeEventListener('resize', onResize);
      unhook?.();
      unhook = null;
      active = null;
      activeRow = null;
      lockKey = '';
    },
    setTargets(targets) {
      const byRepo = new Map<string, Target[]>();
      for (const t of targets) byRepo.set(t.repo, [...(byRepo.get(t.repo) ?? []), t]);
      const old = new Map(live.map((l) => [l.repo, l]));
      const next: Pin[] = [];
      for (const [repo, ts] of byRepo) {
        const pin = old.get(repo) ?? pinFor(repo, ts);
        old.delete(repo);
        pin.targets = ts;
        drawPin(pin);
        next.push(pin);
      }
      for (const gone of old.values()) gone.el.remove();
      pins.replaceChildren(...next.map((x) => x.el));
      live = next;
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
