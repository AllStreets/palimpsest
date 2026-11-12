/**
 * The week tour (Phase 3 Task 17, Decision 5): a silent walk of the camera
 * through the week the engine planned (shared/tour.ts), from the exchange
 * through at most eight stops and back, about ninety seconds, each stop
 * captioned at the lower left in the ride's type. It runs on the camera's
 * scripted path mode, as the ride does: Escape ends it and glides home, a
 * drag or a scroll ends it where it stands. With prefers-reduced-motion it
 * cuts from stop to stop.
 *
 * tourKeys and tourPose are pure (tested in Node): an eye per stop, 95 m
 * out (further for a whole tower, so its crown stands in frame) and a little
 * up, on the bearing it arrives from, turned to a three-quarter view, and
 * moved out of any tower it would stand in; the glides between them follow
 * a Catmull-Rom path through the eyes, eased in and out, arcing up so they
 * pass over the towers rather than through them.
 */
import * as THREE from 'three';

import type { Tour, TourStop } from '../../../shared/types.js';
import type { ScriptPose } from './camera.js';

/** Where something stands, for framing (scene.ts Frame). */
export interface TourFrame {
  center: THREE.Vector3;
  width: number;
  height: number;
}

/** One key of the walk: the stop, where the eye stands and looks while it dwells there, and when its glide in starts. */
export interface TourKey {
  stop: TourStop;
  eye: THREE.Vector3;
  target: THREE.Vector3;
  t: number;
  /** How high the glide into this key arcs at its middle (metres over the path), enough to clear every tower it passes. */
  lift: number;
}

/**
 * The eye: how far out it stands from a floor and how far up, how far it
 * keeps from any tower, the lens's vertical field (camera.ts), the
 * three-quarter view's bounds in degrees off a face, and the drift while it
 * dwells (radians round the target over a stop).
 */
export const TOUR_EYE = { out: 95, up: 25, clear: 8, fov: 36, quarter: [20, 70] as [number, number], drift: 0.06 } as const;

/** How far back to stand from a frame so all of it, a tower's crown included, sits inside the lens. */
function distanceFor(f: TourFrame): number {
  const tan = Math.tan(((TOUR_EYE.fov / 2) * Math.PI) / 180);
  return Math.max(TOUR_EYE.out, f.width * 2.4, f.height > 20 ? (f.height * 0.6) / tan : 0);
}

/** A bearing turned into the three-quarter range, so a face is never square on and a corner never dead ahead. */
function quarter(theta: number): number {
  const deg = (theta * 180) / Math.PI;
  const base = Math.floor(deg / 90) * 90;
  const off = deg - base;
  const [lo, hi] = TOUR_EYE.quarter;
  return ((base + Math.min(hi, Math.max(lo, off))) * Math.PI) / 180;
}

/** Whether a point stands inside any tower's frame, grown by the eye's clearance. */
export function insideAny(p: THREE.Vector3, towers: ReadonlyArray<TourFrame>): boolean {
  return towers.some((t) => Math.abs(p.x - t.center.x) < t.width / 2 + TOUR_EYE.clear && Math.abs(p.z - t.center.z) < t.width / 2 + TOUR_EYE.clear && p.y < t.center.y + t.height / 2 + TOUR_EYE.clear);
}

/**
 * Whether the eye sees its target past every other tower: the sight line,
 * sampled, never passes through a tower's frame (the target's own tower
 * aside, which the line ends in).
 */
export function sightClear(eye: THREE.Vector3, target: THREE.Vector3, towers: ReadonlyArray<TourFrame>): boolean {
  const others = towers.filter((t) => !(Math.abs(target.x - t.center.x) <= t.width / 2 + 1 && Math.abs(target.z - t.center.z) <= t.width / 2 + 1));
  const p = new THREE.Vector3();
  for (let i = 1; i < 20; i++) {
    p.lerpVectors(eye, target, i / 20);
    if (others.some((t) => Math.abs(p.x - t.center.x) < t.width / 2 && Math.abs(p.z - t.center.z) < t.width / 2 && p.y < t.center.y + t.height / 2)) return false;
  }
  return true;
}

/** The eye for a target seen from `theta` at `dist`, moved round or out until it stands clear of every tower, else lifted over them. */
function placeEye(target: THREE.Vector3, theta: number, dist: number, up: number, towers: ReadonlyArray<TourFrame>): THREE.Vector3 {
  const at = (th: number, d: number): THREE.Vector3 => new THREE.Vector3(target.x + Math.cos(th) * d, target.y + up, target.z + Math.sin(th) * d);
  // Round first (the view keeps its distance), then out: the first place clear of the towers and in sight of the target.
  for (let extra = 0; extra <= 200; extra += 20) {
    for (const turn of [0, 15, -15, 30, -30, 45, -45, 60, -60, 90, -90]) {
      const th = quarter(theta + (turn * Math.PI) / 180);
      const p = at(th, dist + extra);
      if (!insideAny(p, towers) && sightClear(p, target, towers)) return p;
    }
  }
  const p = at(quarter(theta), dist);
  p.y = Math.max(...towers.map((t) => t.center.y + t.height / 2)) + TOUR_EYE.clear + 10;
  return p;
}

/**
 * The walk's keys from the engine's tour: the exchange first and last, an
 * eye for each stop whose frame the city still has (a tower gone since the
 * plan is passed over), each key's glide starting where the last one's
 * dwell ended.
 */
export function tourKeys(tour: Tour, frames: (stop: TourStop) => TourFrame | null, exchange: TourFrame, towers: ReadonlyArray<TourFrame>): TourKey[] {
  const keys: TourKey[] = [];
  let prev = exchange.center.clone();
  let t = 0;
  for (const stop of tour.stops) {
    const f = stop.kind === 'exchange' ? exchange : frames(stop);
    if (!f) continue;
    const target = f.center.clone();
    // A whole tower: look a little above its middle, so the crown and the street both stand in the frame.
    if (f.height > 20) target.y += f.height * 0.1;
    const dist = distanceFor(f);
    const away = Math.hypot(prev.x - target.x, prev.z - target.z);
    // The exchange opens and closes the walk from the south east, the side the city is seen from at home.
    const theta = stop.kind === 'exchange' || away < 1 ? Math.PI / 3 : Math.atan2(prev.z - target.z, prev.x - target.x);
    const up = Math.max(TOUR_EYE.up, dist * 0.3);
    const eye = placeEye(target, theta, dist, up, towers);
    keys.push({ stop, eye, target, t, lift: GLIDE.base });
    t += stop.glide + stop.dwell;
    prev = target;
  }
  // Each glide arcs high enough over its path to clear every tower it passes, sampled along tourPose's own curve.
  if (keys.length > 1) {
    const curve = new THREE.CatmullRomCurve3(keys.map((x) => x.eye.clone()), false, 'centripetal');
    for (let i = 1; i < keys.length; i++) {
      const base = Math.max(GLIDE.base, keys[i - 1].eye.distanceTo(keys[i].eye) * 0.12);
      let lift = base;
      for (let j = 0; j <= GLIDE.samples; j++) {
        const s = 0.1 + (0.8 * j) / GLIDE.samples;
        const p = curve.getPoint((i - 1 + s) / (keys.length - 1));
        const arc = Math.sin(Math.PI * s);
        for (const tw of towers) {
          if (Math.abs(p.x - tw.center.x) >= tw.width / 2 + TOUR_EYE.clear || Math.abs(p.z - tw.center.z) >= tw.width / 2 + TOUR_EYE.clear) continue;
          const needed = tw.center.y + tw.height / 2 + TOUR_EYE.clear + 2 - p.y;
          if (needed > 0) lift = Math.max(lift, needed / arc);
        }
      }
      keys[i].lift = Math.min(GLIDE.cap, lift);
    }
  }
  return keys;
}

/** A glide's arc: at least this high, sampled this many times along its path for towers, never higher than the cap. */
const GLIDE = { base: 20, samples: 24, cap: 420 } as const;

/** The walk's seconds: every glide and every dwell. */
export function tourLength(keys: ReadonlyArray<TourKey>): number {
  return keys.reduce((n, k) => n + k.stop.glide + k.stop.dwell, 0);
}

const ease = (x: number): number => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const paths = new WeakMap<ReadonlyArray<TourKey>, THREE.CatmullRomCurve3>();

/**
 * Where the camera stands at `time` into the walk: gliding along the path
 * into a key (eased, arcing up over the straight line), or dwelling at it,
 * drifting a little round its target. `still` (reduced motion) stands at
 * each key from the start of its glide to the end of its dwell: a cut.
 */
export function tourPose(keys: ReadonlyArray<TourKey>, time: number, still = false): { eye: THREE.Vector3; target: THREE.Vector3; index: number; dwelling: boolean } {
  let i = keys.length - 1;
  for (let j = 0; j < keys.length; j++) {
    if (time < keys[j].t + keys[j].stop.glide + keys[j].stop.dwell) {
      i = j;
      break;
    }
  }
  const k = keys[i];
  const local = Math.max(0, time - k.t);
  if (still) return { eye: k.eye.clone(), target: k.target.clone(), index: i, dwelling: true };
  if (i > 0 && local < k.stop.glide) {
    let curve = paths.get(keys);
    if (!curve) paths.set(keys, (curve = new THREE.CatmullRomCurve3(keys.map((x) => x.eye.clone()), false, 'centripetal')));
    const s = ease(local / k.stop.glide);
    const eye = curve.getPoint((i - 1 + s) / (keys.length - 1));
    const from = keys[i - 1];
    // Over the towers between, not through them: the arc tourKeys worked out for this glide.
    eye.y += Math.sin(Math.PI * s) * k.lift;
    const target = from.target.clone().lerp(k.target, s);
    return { eye, target, index: i, dwelling: false };
  }
  const u = Math.min(1, (local - (i > 0 ? k.stop.glide : 0)) / Math.max(1e-6, k.stop.dwell));
  const phi = TOUR_EYE.drift * (u - 0.5);
  const off = k.eye.clone().sub(k.target);
  off.applyAxisAngle(new THREE.Vector3(0, 1, 0), phi);
  return { eye: k.target.clone().add(off), target: k.target.clone(), index: i, dwelling: true };
}

// ---------------------------------------------------------------- the walk in the city

/** What the tour needs of the city (scene.ts gives all of it). */
export interface TourHost {
  camera: THREE.PerspectiveCamera;
  script(path: (dt: number) => ScriptPose | null, onRelease?: (why: 'user' | 'end') => void): void;
  unscript(): void;
  highlightFloor(repo: string, floorId: string | null): void;
  highlightLook(look: { color: THREE.Color; alpha: number } | null): void;
  view(eye: THREE.Vector3, target: THREE.Vector3): void;
  viewTarget(): THREE.Vector3;
  home(): void;
}

export interface TourOptions {
  parent: HTMLElement;
  /** prefers-reduced-motion: cut from stop to stop. */
  still?: boolean;
  /** The week's own name for the exchange's caption line ("the week of November 9"). */
  weekLine: string;
  /** Each stop as the walk reaches it. */
  onStop?(key: TourKey, index: number): void;
  onEnd?(why: 'end' | 'escape' | 'user'): void;
}

export interface TourWalk {
  stop(): void;
  next(): void;
  state(): { t: number; length: number; index: number; caption: string | null; dwelling: boolean };
  hold(on: boolean): void;
  seek(t: number): void;
  done: Promise<void>;
}

/** The floor mark's bronze, as the ride marks the floor its caption speaks of. */
const MARK_BRONZE = new THREE.Color(0.86, 0.6, 0.32);
/** Seconds to come from where the view stood to the walk's first key. */
const APPROACH = 2.5;

/** The tour's captions: the ride's set (style.css .ride), with the stop's number in place of the floor's. */
function tourCaptions(parent: HTMLElement, act: { off(): void; next(): void }): { show(title: string, line: string, n: number, of: number): void; dispose(): void } {
  const el = document.createElement('div');
  el.className = 'ride tour';
  const floor = document.createElement('p');
  floor.className = 'ride-floor';
  const n = document.createElement('span');
  n.className = 'ride-n';
  const of = document.createElement('span');
  of.className = 'ride-of';
  floor.append(n, of);
  const cap = document.createElement('div');
  cap.className = 'ride-caption';
  cap.setAttribute('role', 'status');
  cap.setAttribute('aria-live', 'polite');
  const title = document.createElement('p');
  title.className = 'ride-title';
  const line = document.createElement('p');
  line.className = 'ride-line';
  const date = document.createElement('span');
  date.className = 'ride-date';
  line.append(date);
  cap.append(title, line);
  const keys = document.createElement('p');
  keys.className = 'ride-keys';
  const keyed = (cls: string, kbd: string, word: string, label: string, fn: () => void): HTMLButtonElement => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = cls;
    const k = document.createElement('kbd');
    k.textContent = kbd;
    b.append(k, document.createTextNode(word));
    b.setAttribute('aria-label', label);
    b.addEventListener('click', fn);
    return b;
  };
  keys.append(keyed('ride-off', 'Esc', 'End the tour', 'End the tour', act.off), keyed('ride-next', 'Space', 'Next stop', 'Go on to the next stop', act.next));
  el.append(floor, cap, keys);
  parent.append(el);
  requestAnimationFrame(() => el.classList.add('on'));
  return {
    show(t, l, i, total) {
      title.textContent = t;
      date.textContent = l;
      date.hidden = !l;
      // The exchange opens and closes the walk unnumbered; the stops count from one.
      // (The ride's style sets the line's display, so it is hidden by its visibility, keeping the caption where it stands.)
      floor.style.visibility = i < 1 || i > total ? 'hidden' : '';
      n.textContent = String(i);
      of.textContent = `of ${total}`;
      cap.classList.remove('on');
      void cap.offsetWidth;
      cap.classList.add('on');
    },
    dispose() {
      el.classList.remove('on');
      setTimeout(() => el.remove(), 400);
    },
  };
}

/** The tower key a stop's floor is marked on: a district's repo, or `agent:<id>`. */
function markKey(s: TourStop): string | null {
  if (s.towerId?.startsWith('agent:')) return s.towerId;
  return s.repo;
}

/** Walks the camera through `keys`. */
export function startTour(city: TourHost, keys: TourKey[], opts: TourOptions): TourWalk {
  const length = tourLength(keys);
  const still = !!opts.still;
  const fromEye = city.camera.position.clone();
  const fromTarget = city.viewTarget();
  let t = still ? 0 : -APPROACH;
  let held = false;
  let ended = false;
  let index = -1;
  let dwelling = false;
  let reason: 'end' | 'escape' = 'escape';
  let captionNow: string | null = null;
  let resolve: () => void = () => {};
  const done = new Promise<void>((r) => (resolve = r));
  const stops = keys.length - 2;
  const cap = tourCaptions(opts.parent, { off: () => api.stop(), next: () => skip() });
  const eye = new THREE.Vector3();
  const target = new THREE.Vector3();

  const end = (why: 'end' | 'escape' | 'user'): void => {
    if (ended) return;
    ended = true;
    removeEventListener('keydown', onKey, true);
    const k = keys[index];
    if (k) {
      const key = markKey(k.stop);
      if (key && k.stop.floorId) city.highlightFloor(key, null);
    }
    city.highlightLook(null);
    cap.dispose();
    if (why !== 'user') {
      if (still) city.view(fromEye, fromTarget);
      city.home();
    }
    opts.onEnd?.(why);
    resolve();
  };
  /** Space or Right: on to the next stop's dwell at once. */
  const skip = (): void => {
    if (ended) return;
    const i = Math.max(0, index) + 1;
    if (i < keys.length) t = keys[i].t + (still ? 0 : keys[i].stop.glide);
  };
  const onKey = (e: KeyboardEvent): void => {
    if (ended || e.metaKey || e.ctrlKey || e.altKey) return;
    // A sheet over the city keeps its own keys: Escape there closes the sheet, not the walk.
    const route = document.body.dataset.route;
    if (route && route !== 'city') return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      reason = 'escape';
      city.unscript();
    } else if (e.key === ' ' || e.key === 'ArrowRight') {
      const tgt = e.target as HTMLElement | null;
      if (tgt && (tgt.isContentEditable || /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(tgt.tagName))) return;
      e.preventDefault();
      e.stopPropagation();
      skip();
    }
  };
  addEventListener('keydown', onKey, true);

  const step = (dt: number): ScriptPose | null => {
    if (ended) return null;
    if (!held) t += dt;
    if (t >= length) {
      reason = 'end';
      return null;
    }
    const pose = tourPose(keys, Math.max(0, t), still);
    if (t < 0) {
      const k = ease(1 + t / APPROACH);
      eye.lerpVectors(fromEye, pose.eye, k);
      target.lerpVectors(fromTarget, pose.target, k);
    } else {
      eye.copy(pose.eye);
      target.copy(pose.target);
    }
    dwelling = pose.dwelling;
    if (pose.index !== index) {
      const was = keys[index];
      if (was) {
        const key = markKey(was.stop);
        if (key && was.stop.floorId) city.highlightFloor(key, null);
      }
      index = pose.index;
      const k = keys[index];
      const ex = k.stop.kind === 'exchange';
      const day = ex ? opts.weekLine : k.stop.caption.startsWith(`${k.stop.title}, `) ? k.stop.caption.slice(k.stop.title.length + 2) : '';
      cap.show(ex ? 'The exchange' : k.stop.title, day, ex ? 0 : index, Math.max(1, stops));
      captionNow = ex ? 'The exchange' : k.stop.title;
      const key = markKey(k.stop);
      if (key && k.stop.floorId) city.highlightFloor(key, k.stop.floorId);
      opts.onStop?.(k, index);
    }
    // The stop's floor in bronze while the walk dwells there, fading in as it arrives.
    const k = keys[index];
    if (k?.stop.floorId) {
      const local = Math.max(0, t) - k.t - (still ? 0 : k.stop.glide);
      const a = still ? 1 : Math.min(1, Math.max(0, local / 0.6)) * Math.min(1, Math.max(0, (k.stop.dwell - local) / 0.6));
      city.highlightLook({ color: MARK_BRONZE, alpha: a * 0.7 });
    } else city.highlightLook(null);
    return { eye, target };
  };
  city.script(step, (why) => end(why === 'user' ? 'user' : reason));

  const api: TourWalk = {
    stop() {
      if (ended) return;
      reason = 'escape';
      city.unscript();
    },
    next: skip,
    state: () => ({ t, length, index, caption: captionNow, dwelling }),
    hold(on) {
      held = on;
    },
    seek(at) {
      t = at;
    },
    done,
  };
  return api;
}
