import * as THREE from 'three';

import type { Floor } from '../../../shared/types.js';
import { marketKey } from '../ui/inspector.js';

/** A district's or a firm's quarter's name plate: what it says, where it stands, what clicking it does. */
export interface Plate {
  key: string;
  origin: { x: number; z: number };
  name: string;
  /** The quieter second line: owner and floor count, the analysis step, or a firm's agents and credits. */
  sub: string;
  onActivate?: () => void;
  /** A plate that stands at a live point (a persona's figure, people.ts) rather than beside a district's origin. */
  at?: (out: THREE.Vector3) => THREE.Vector3;
  /** Its own fade band in metres from the eye (the districts' is FADE_START to FADE_END). */
  fade?: { start: number; end: number };
  /** A class on the plate's element besides `plate`. */
  className?: string;
  /** What hovering the plate says besides its name (a tower's band key). */
  title?: string;
}

/** The words stand this far right of the hairline (style.css .plate-name, left: 7px), and keep this clear of the view's edge. */
const WORDS_OFF = 7;
const EDGE = 8;

/**
 * Whether a plate whose hairline stands at `x` sets its words (`words`
 * pixels wide) left of the hairline: when, set right of it, they would run
 * past the view's right edge, and set left they still fit.
 */
export function plateFlips(x: number, words: number, viewWidth: number): boolean {
  return x + WORDS_OFF + words > viewWidth - EDGE && x - WORDS_OFF - words >= EDGE;
}

/** How far above its foot a plate's name stands, top to foot (style.css .plate-name: bottom 15px, 16px type). */
const NAME_RISE = 32;

/**
 * Whether a plate with its foot at (`x`, `y`) shows its words (`words` pixels wide, `flip` set left of the hairline)
 * whole within a `viewWidth` by `viewHeight` view, `margin` pixels in from its edges (Task 15a): a plate whose name would
 * run off an edge is not shown.
 */
export function plateFits(x: number, y: number, words: number, flip: boolean, viewWidth: number, viewHeight: number, margin = 0): boolean {
  const x0 = flip ? x - WORDS_OFF - words : x + WORDS_OFF;
  return x0 >= margin && x0 + words <= viewWidth - margin && y - NAME_RISE >= margin && y <= viewHeight - margin;
}

/**
 * The part of the window the city shows through: the whole window, or right of an open sheet's edge (audit
 * 2026-11-17). The screens set its left edge (plate-guard.ts); the plates keep their flip and their fit inside it.
 */
let paneLeft = 0;

/** Sets the visible pane's left edge in pixels: an open sheet's right edge, or 0 when no sheet is open. */
export function setPlatePane(left: number): void {
  paneLeft = Number.isFinite(left) && left > 0 ? left : 0;
}

/**
 * Where a plate with its foot at (`x`, `y`) sets its words within the pane, and whether they stand whole inside
 * it: the flip and the fit measured from the pane's left edge to its right, not the window's.
 */
export function placeInPane(x: number, y: number, words: number, pane: { left: number; right: number; height: number }, margin = 0): { flip: boolean; fits: boolean } {
  const width = Math.max(0, pane.right - pane.left);
  const at = x - pane.left;
  const flip = plateFlips(at, words, width);
  return { flip, fits: at >= 0 && plateFits(at, y, words, flip, width, pane.height, margin) };
}

/** The room kept between two plates' boxes, in pixels. */
const PLATE_GAP = 2;

/**
 * Which of the shown plates (given in priority order, the first wins) to hide
 * while their words collide: each plate's box runs from its words' edge (right
 * of the hairline, or left of it once flipped) and from NAME_RISE above its
 * foot down to the foot. A plate hides when it overlaps an earlier plate that
 * stays; a hidden plate hides nothing. Returns the indices to hide.
 */
export function platesToHide(plates: ReadonlyArray<{ x: number; y: number; words: number; flip: boolean }>): Set<number> {
  const hide = new Set<number>();
  const kept: Array<{ x0: number; x1: number; y0: number; y1: number }> = [];
  plates.forEach((p, i) => {
    const x0 = p.flip ? p.x - WORDS_OFF - p.words : p.x + WORDS_OFF;
    const box = { x0, x1: x0 + p.words, y0: p.y - NAME_RISE, y1: p.y };
    const hit = kept.some((k) => box.x0 < k.x1 + PLATE_GAP && k.x0 < box.x1 + PLATE_GAP && box.y0 < k.y1 + PLATE_GAP && k.y0 < box.y1 + PLATE_GAP);
    if (hit) hide.add(i);
    else kept.push(box);
  });
  return hide;
}

/** A plate hidden for running off the view shows again only once it fits with this many pixels to spare, so it never flickers at the edge. */
export const PLATE_FIT_SPARE = 8;

/** The class a flipped plate wears (style.css sets its words right-aligned left of the hairline). */
export const PLATE_FLIP = 'plate-flip';

/**
 * What the lit and dark bands on a tower are, said on its plate: the
 * inspector's market key, one source for the words (Task 26).
 */
export const bandKey: (floors: readonly Floor[]) => string = marketKey;

export interface Plates {
  set(plates: Plate[]): void;
  /** Repositions every plate for the current camera. Call once per frame, after the camera moves. */
  update(): void;
  dispose(): void;
}

/** Plates stand this far out from the district's centre, on the side facing the eye, at street level. */
const STAND_OFF = 26;
/** Plates fade out between these eye distances, in metres. */
const FADE_START = 1500;
const FADE_END = 2300;
/**
 * Occlusion is tested every few frames: towers move slowly against the eye.
 * Each frame tests its share of the plates (every OCCLUSION_EVERY-th, in
 * turn), so each plate is still tested every OCCLUSION_EVERY frames but no
 * frame casts every plate's ray at once (Task 13: a city-wide instanced
 * blocker makes each ray costly, and all of them together a hitch).
 */
const OCCLUSION_EVERY = 6;

interface Live {
  plate: Plate;
  el: HTMLButtonElement;
  name: HTMLSpanElement;
  sub: HTMLSpanElement;
  hidden: boolean;
  /** The words' width in pixels, measured once they show (0 until then), and whether they stand left of the hairline. */
  words: number;
  flipped: boolean;
  /** Tested for occlusion at least once since it was made. */
  tested: boolean;
  /** Hidden for running off the view (plateFits), until it fits with PLATE_FIT_SPARE to spare. */
  clipped: boolean;
}

/**
 * Street-level name plates: one per district, set in the index's type, a
 * hairline standing from the pavement up to the name. Each plate stands on
 * the plaza edge nearest the eye, so the tower never hides its own name, and
 * hides when another tower stands in front of it.
 */
export function createPlates(
  host: HTMLElement,
  camera: THREE.PerspectiveCamera,
  occluders: () => THREE.Object3D[],
): Plates {
  const layer = document.createElement('div');
  layer.className = 'plates';
  host.appendChild(layer);

  let live: Live[] = [];
  let frame = 0;
  const raycaster = new THREE.Raycaster();
  // The ambient blocks draw on the view's own layer (lod.ts): the plates test against every layer.
  raycaster.layers.enableAll();
  const at = new THREE.Vector3();
  const ndc = new THREE.Vector3();
  const toward = new THREE.Vector3();
  const ray = new THREE.Vector3();

  function anchor(p: Plate, out: THREE.Vector3): THREE.Vector3 {
    if (p.at) return p.at(out);
    toward.set(camera.position.x - p.origin.x, 0, camera.position.z - p.origin.z);
    if (toward.lengthSq() < 1e-6) toward.set(1, 0, 1);
    toward.normalize();
    // A quarter turn to the right of the line of sight, so the plate stands beside the root, not in front of it.
    const side = new THREE.Vector3(toward.z, 0, -toward.x);
    return out.set(p.origin.x, 0.5, p.origin.z).addScaledVector(toward, STAND_OFF * 0.75).addScaledVector(side, STAND_OFF * 0.75);
  }

  /** The flip as a class for the stylesheet, and inline as well, so the words never clip without the rule. */
  function setFlip(l: Live, on: boolean): void {
    l.flipped = on;
    l.el.classList.toggle(PLATE_FLIP, on);
  }

  return {
    set(plates) {
      const byKey = new Map(live.map((l) => [l.plate.key, l]));
      const next: Live[] = [];
      for (const plate of plates) {
        let l = byKey.get(plate.key);
        if (l) {
          byKey.delete(plate.key);
          l.plate = plate;
        } else {
          const el = document.createElement('button');
          el.type = 'button';
          el.className = plate.className ? `plate ${plate.className}` : 'plate';
          const name = document.createElement('span');
          name.className = 'plate-name';
          const sub = document.createElement('span');
          sub.className = 'plate-sub';
          el.append(name, sub);
          layer.appendChild(el);
          l = { plate, el, name, sub, hidden: false, words: 0, flipped: false, tested: false, clipped: false };
          const self = l;
          el.addEventListener('click', () => self.plate.onActivate?.());
        }
        if (l.name.textContent !== plate.name || l.sub.textContent !== plate.sub) l.words = 0;
        l.name.textContent = plate.name;
        l.sub.textContent = plate.sub;
        l.el.setAttribute('aria-label', `${plate.name}, ${plate.sub}${plate.title ? `. ${plate.title}` : ''}`);
        if (plate.title) l.el.title = plate.title;
        else l.el.removeAttribute('title');
        l.el.disabled = !plate.onActivate;
        next.push(l);
      }
      for (const gone of byKey.values()) gone.el.remove();
      live = next;
      frame = 0;
    },
    update() {
      const w = host.clientWidth;
      const h = host.clientHeight;
      const turn = frame++ % OCCLUSION_EVERY;
      // Gathered only in a frame that tests a plate, the first time one does.
      let targets: THREE.Object3D[] | null = null;
      const shown: Array<{ l: Live; x: number; y: number; words: number; flip: boolean }> = [];
      for (let i = 0; i < live.length; i++) {
        const l = live[i];
        // A plate is tested in its turn, and a new one on its first frame (so it never shows through a tower first).
        const testOcclusion = i % OCCLUSION_EVERY === turn || !l.tested;
        anchor(l.plate, at);
        const dist = at.distanceTo(camera.position);
        ndc.copy(at).project(camera);
        const behind = ndc.z > 1 || ndc.z < -1;
        const fade = 1 - THREE.MathUtils.smoothstep(dist, l.plate.fade?.start ?? FADE_START, l.plate.fade?.end ?? FADE_END);
        if (testOcclusion && !behind) {
          raycaster.set(camera.position, ray.copy(at).sub(camera.position).normalize());
          raycaster.far = dist - 2;
          targets ??= occluders();
          l.hidden = raycaster.intersectObjects(targets, false).length > 0;
          l.tested = true;
        }
        const show = !behind && !l.hidden && fade > 0.01;
        l.el.style.opacity = show ? fade.toFixed(3) : '0';
        l.el.style.visibility = show ? 'visible' : 'hidden';
        if (!show) continue;
        const x = (ndc.x * 0.5 + 0.5) * w;
        const y = (-ndc.y * 0.5 + 0.5) * h;
        l.el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
        // Near the right edge the words stand left of the hairline rather than clipping (plateFlips); measured once.
        if (!l.words) l.words = Math.max(l.name.offsetWidth, l.sub.offsetWidth);
        // Behind a sheet the view is the pane right of it: the flip and the fit keep the words inside it.
        const placed = l.words > 0 ? placeInPane(x, y, l.words, { left: Math.min(paneLeft, w), right: w, height: h }, l.clipped ? PLATE_FIT_SPARE : 0) : null;
        const flip = placed?.flip ?? false;
        if (flip !== l.flipped) setFlip(l, flip);
        // A plate whose words would still run off the view (its foot past an edge, or its name over the top) waits
        // until the eye turns to it: a name is shown whole or not at all (Task 15a).
        l.clipped = placed !== null && !placed.fits;
        if (l.clipped) {
          l.el.style.opacity = '0';
          l.el.style.visibility = 'hidden';
        } else if (l.words > 0) {
          shown.push({ l, x, y, words: l.words, flip });
        }
      }
      // Two plates whose words collide (a flip at the right edge can bring one over another): the later waits while they do.
      const hide = platesToHide(shown);
      shown.forEach((s, i) => {
        if (!hide.has(i)) return;
        s.l.el.style.opacity = '0';
        s.l.el.style.visibility = 'hidden';
      });
    },
    dispose() {
      layer.remove();
      live = [];
    },
  };
}
