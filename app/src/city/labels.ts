import * as THREE from 'three';

import type { Floor } from '../../../shared/types.js';

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
 * whole within a `viewWidth` by `viewHeight` view (Task 15a): a plate whose name would run off an edge is not shown.
 */
export function plateFits(x: number, y: number, words: number, flip: boolean, viewWidth: number, viewHeight: number): boolean {
  const x0 = flip ? x - WORDS_OFF - words : x + WORDS_OFF;
  return x0 >= 0 && x0 + words <= viewWidth && y - NAME_RISE >= 0 && y <= viewHeight;
}

/** The class a flipped plate wears (style.css sets its words right-aligned left of the hairline). */
export const PLATE_FLIP = 'plate-flip';

/**
 * What the lit and dark bands on a tower are, said on its plate: the
 * inspector's market key (ui/inspector.ts marketKey) in the same words, for
 * the kinds of floor this tower holds. Empty when it holds none.
 */
export function bandKey(floors: readonly Floor[]): string {
  const states = new Set(floors.map((f) => f.earned?.state).filter(Boolean));
  if (!states.size) return '';
  const parts: string[] = [];
  if (states.has('lit')) parts.push('A lit floor is a change a firm built here that you merged');
  if (states.has('scar')) parts.push(`${parts.length ? 'a' : 'A'} dark band is a scar, work that failed inspection, kept where it failed`);
  if (states.has('waiting')) parts.push(`${parts.length ? 'a' : 'A'} floor still unlit waits on your review`);
  return `${parts.join('; ')}.`;
}

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
    for (const span of [l.name, l.sub]) {
      span.style.left = on ? 'auto' : '';
      span.style.right = on ? `${WORDS_OFF}px` : '';
      span.style.textAlign = on ? 'right' : '';
    }
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
          l = { plate, el, name, sub, hidden: false, words: 0, flipped: false, tested: false };
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
        const flip = l.words > 0 && plateFlips(x, l.words, w);
        if (flip !== l.flipped) setFlip(l, flip);
        // A plate whose words would still run off the view (its foot past an edge, or its name over the top) waits
        // until the eye turns to it: a name is shown whole or not at all (Task 15a).
        if (l.words > 0 && !plateFits(x, y, l.words, flip, w, h)) {
          l.el.style.opacity = '0';
          l.el.style.visibility = 'hidden';
        }
      }
    },
    dispose() {
      layer.remove();
      live = [];
    },
  };
}
