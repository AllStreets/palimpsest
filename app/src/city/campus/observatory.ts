/**
 * The university's observatory (Phase 4 Task 36), where the master net
 * lives: a twelve-sided brick drum with limestone dressings at the back
 * corner of the terrace, a copper dome green with patina on it, a slit in
 * the dome under a pair of bi-parting shutters, and a great refractor on a
 * stone pier inside.
 *
 * While the nets train the shutters part, the inside is lit warm and the
 * telescope turns slowly in the slit; between trainings the dome is shut
 * and the telescope stands still. A brass plate by the door, under its own
 * lantern, is lit only while the master is trusted; a thin master leaves
 * the whole thing shut and dark.
 *
 * What it costs: the drum, the dome, its lining, the pier, the steps and
 * the plate are built in the caller's Kit and stamped into the site's one
 * draw. Its own objects are two meshes in the campus's masonry: the two
 * shutter leaves (one geometry, each leaf swung about the slit's axis in
 * place while it moves) and the telescope tube. The warm light inside and
 * the plate are emission in the masonry shader (`uSlitLit`, `uPlateLit`),
 * under the bloom threshold: no light is added. Pure three.js: tested in
 * Node.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

import { Kit, M, piercedWall, rng } from '../tower/kit.js';
import { Gothic, MAT, outline, type Opening } from './gothic.js';
import { mergeStamped, stamp, type Kind } from './site.js';

/** The route a click on the dome opens: the school screen at the master's card (Task 28). */
export const SCHOOL_MASTER_ROUTE = '#/school/master';

/**
 * The observatory's measure, in metres from the terrace: the drum's radius
 * to its faces and its height to the cornice, the dome's radius and the
 * height of its centre (the top of the copper curb), the slit's half width.
 */
export const OBSERVATORY = { drum: 7.2, faces: 12, drumTop: 8.6, dome: 7.8, centre: 9.8, slitHalf: 1.2, apex: 9.8 + 7.8 } as const;

/** The dome's frame: its centre, turned so the slit's front and the door face the campus. */
const SLIT_FROM = 0.1; // the slit starts this far up the dome from the curb, in radians
const SLIT_TO = Math.PI / 2 + 0.36; // and runs over the apex to here (20 degrees past the zenith)
const SHELL = 0.22; // the dome's thickness
/** How far each leaf swings about the slit's axis when open. */
const LEAF_SWING = 0.6;
/** Seconds the shutters take to open or close. */
const SHUTTER_SECONDS = 6;

export interface ObservatoryState {
  /** The nets are training now: the slit open, the inside lit, the telescope turning. */
  training: boolean;
  /** The master's current version beats its baseline: the plate by the door is lit. */
  masterTrusted: boolean;
  /** The master's current version (0 before one is promoted); each version looks at a new part of the sky. */
  version: number;
}

export interface ObservatoryOptions {
  /** The campus's masonry material: the shutter and the telescope draw in it, and its uniforms light the inside and the plate. */
  masonry: THREE.Material;
  quality: 'high' | 'medium';
  seed?: string;
  /** The azimuth the slit's front and the door face, in the Kit's frame (radians about y from +z toward +x). */
  facing?: number;
}

export interface ObservatoryView {
  /** How far the shutters stand open, 0 shut to 1. */
  open: number;
  training: boolean;
  /** The plate by the door is lit. */
  lit: boolean;
  version: number;
  /** Where the telescope points: altitude and azimuth within the slit, radians. */
  altitude: number;
  azimuth: number;
}

export interface Observatory {
  /** The observatory's own objects: the shutter leaves and the telescope; the masonry went into the Kit. */
  group: THREE.Group;
  shutter: THREE.Mesh;
  telescope: THREE.Mesh;
  /** The dome's pick proxy, mapped to the route it opens. */
  pickables: Map<THREE.Object3D, string>;
  setState(s: ObservatoryState): void;
  /** Per frame: moves the shutters toward their state and turns the telescope while training. */
  update(dt: number): void;
  view(): ObservatoryView;
  dispose(): void;
}

// ---------------------------------------------------------------- the ledger's events

/**
 * Folds one of the school's ledger events into the observatory's state
 * (main.ts feeds it the stream): a nets train starting or ending opens or
 * shuts it; the master's trained versions are remembered and the promoted
 * one, if trusted, lights the plate; a version trained but not yet promoted
 * only turns the telescope to a new piece of sky. Anything else returns the
 * same state.
 */
export function foldSchoolEvent(s: ObservatoryState, e: { type: string; data: unknown }, memory: { running: Set<string>; trusted: Map<number, boolean> } = schoolMemory): ObservatoryState {
  const d = (e.data ?? {}) as Record<string, unknown>;
  switch (e.type) {
    case 'train.started':
    case 'train.paused':
    case 'train.ended': {
      const t = d.train as { id?: string; kind?: string } | undefined;
      if (!t?.id || t.kind !== 'nets') return s;
      if (e.type === 'train.started') memory.running.add(t.id);
      else memory.running.delete(t.id);
      const training = memory.running.size > 0;
      return training === s.training ? s : { ...s, training };
    }
    case 'net.trained': {
      const v = d.netVersion as { net?: string; version?: number; trusted?: boolean } | undefined;
      if (!v || v.net !== 'master' || typeof v.version !== 'number') return s;
      memory.trusted.set(v.version, v.trusted === true);
      // A new version looks at a new part of the sky; the plate waits for it to be promoted.
      return v.version === s.version ? s : { ...s, version: v.version };
    }
    case 'net.promoted': {
      if (d.net !== 'master' || typeof d.version !== 'number') return s;
      const masterTrusted = memory.trusted.get(d.version) ?? false;
      return { ...s, version: d.version, masterTrusted };
    }
    default:
      return s;
  }
}
/** What the fold remembers between events: the nets trains running, and each master version's trust. */
const schoolMemory = { running: new Set<string>(), trusted: new Map<number, boolean>() };

// ---------------------------------------------------------------- the dome's surfaces

/**
 * A piece of a sphere of radius R about the origin, over the slit's own
 * coordinates: `psi` is the angle out of the slit's plane (x = R sin psi),
 * `lam` the angle along the slit's great circle from the front of the base
 * (z = R cos psi at lam 0) over the apex (lam pi/2) to the back. Cells for
 * which `skip` holds are left out; `inward` flips the normals for a lining.
 * UVs are metres round the dome's own axis and down from its apex, so the
 * shader's standing seams run from the apex like a real dome's and its
 * streaks run down.
 */
function sphereGrid(R: number, psis: number[], lams: number[], skip: (psi: number, lam: number) => boolean, inward = false): THREE.BufferGeometry {
  const pos: number[] = [];
  const nor: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const at = (psi: number, lam: number): [number, number, number] => [R * Math.sin(psi), R * Math.cos(psi) * Math.sin(lam), R * Math.cos(psi) * Math.cos(lam)];
  for (const psi of psis) {
    for (const lam of lams) {
      const p = at(psi, lam);
      pos.push(...p);
      const s = inward ? -1 : 1;
      nor.push((s * p[0]) / R, (s * p[1]) / R, (s * p[2]) / R);
      uv.push(Math.atan2(p[0], p[2]) * R, Math.acos(Math.min(1, Math.max(-1, p[1] / R))) * R);
    }
  }
  const n = lams.length;
  for (let i = 0; i < psis.length - 1; i++) {
    for (let j = 0; j < n - 1; j++) {
      if (skip((psis[i] + psis[i + 1]) / 2, (lams[j] + lams[j + 1]) / 2)) continue;
      const a = i * n + j;
      const b = a + n;
      if (inward) idx.push(a, a + 1, b, a + 1, b + 1, b);
      else idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

/** A geometry's own 0..1 UVs scaled to metres, so the copper's seams keep their size on it. */
function metresUv(g: THREE.BufferGeometry, su: number, sv: number): THREE.BufferGeometry {
  const uv = g.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
  return g;
}

/** Angles from a to b in n equal steps, both ends included. */
function steps(a: number, b: number, n: number): number[] {
  return Array.from({ length: n + 1 }, (_, i) => a + ((b - a) * i) / n);
}

/** A flat quad a, b, c, d (counter-clockwise seen from its front) as two triangles with a face normal. */
function quad(out: { pos: number[]; nor: number[]; uv: number[] }, a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3): void {
  const n = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(d, a)).normalize();
  for (const p of [a, b, c, a, c, d]) {
    out.pos.push(p.x, p.y, p.z);
    out.nor.push(n.x, n.y, n.z);
    out.uv.push(p.x, p.y);
  }
}

function flatGeometry(out: { pos: number[]; nor: number[]; uv: number[] }): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(out.pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(out.nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(out.uv, 2));
  return g;
}

/** The dome's shell, pierced for the slit, with the slit's cheeks and ends in the thickness of the copper. */
function domeShell(detail: boolean): { outer: THREE.BufferGeometry; cheeks: THREE.BufferGeometry; lining: THREE.BufferGeometry } {
  const R = OBSERVATORY.dome;
  const ps = Math.asin(OBSERVATORY.slitHalf / R);
  const side = detail ? 20 : 12;
  const along = detail ? 36 : 22;
  const psis = [...steps(-Math.PI / 2, -ps, side), ...steps(-ps, ps, 4).slice(1), ...steps(ps, Math.PI / 2, side).slice(1)];
  const lams = [...steps(0, SLIT_FROM, 1), ...steps(SLIT_FROM, SLIT_TO, along).slice(1), ...steps(SLIT_TO, Math.PI, Math.round(along * 0.45)).slice(1)];
  const inSlit = (psi: number, lam: number): boolean => Math.abs(psi) < ps && lam > SLIT_FROM && lam < SLIT_TO;
  const outer = sphereGrid(R, psis, lams, inSlit);
  const lining = sphereGrid(R - SHELL, psis, lams, inSlit, true);
  // The cheeks: the copper's thickness down each side of the slit, and across its two ends.
  const out = { pos: [] as number[], nor: [] as number[], uv: [] as number[] };
  const P = (r: number, psi: number, lam: number): THREE.Vector3 => new THREE.Vector3(r * Math.sin(psi), r * Math.cos(psi) * Math.sin(lam), r * Math.cos(psi) * Math.cos(lam));
  const edge = lams.filter((l) => l >= SLIT_FROM - 1e-9 && l <= SLIT_TO + 1e-9);
  for (let j = 0; j < edge.length - 1; j++) {
    const [l0, l1] = [edge[j], edge[j + 1]];
    quad(out, P(R, ps, l0), P(R - SHELL, ps, l0), P(R - SHELL, ps, l1), P(R, ps, l1));
    quad(out, P(R, -ps, l0), P(R, -ps, l1), P(R - SHELL, -ps, l1), P(R - SHELL, -ps, l0));
  }
  quad(out, P(R, -ps, SLIT_FROM), P(R - SHELL, -ps, SLIT_FROM), P(R - SHELL, ps, SLIT_FROM), P(R, ps, SLIT_FROM));
  quad(out, P(R, -ps, SLIT_TO), P(R, ps, SLIT_TO), P(R - SHELL, ps, SLIT_TO), P(R - SHELL, -ps, SLIT_TO));
  return { outer, cheeks: flatGeometry(out), lining };
}

/**
 * One shutter leaf: a band of the sphere just above the dome from the
 * slit's centre line out past its edge, running from below the slit's
 * foot to beyond its head, with a skirt down to the copper round its
 * edges and a standing rib along its meeting edge. `side` is +1 for the
 * leaf on +x, -1 for its pair, which rides a hand lower so the two overlap.
 */
function leaf(side: 1 | -1, detail: boolean): THREE.BufferGeometry {
  const R = OBSERVATORY.dome;
  const ps = Math.asin(OBSERVATORY.slitHalf / R);
  const lift = side > 0 ? 0.2 : 0.12;
  const r = R + lift;
  const over = 0.32 / R;
  const meet = side > 0 ? -0.04 / R : 0.1 / R;
  const psis = steps(side > 0 ? meet : -(ps + over), side > 0 ? ps + over : -meet, detail ? 6 : 4);
  const lams = steps(SLIT_FROM - 0.2 / R, SLIT_TO + 0.3 / R, detail ? 34 : 20);
  const face = sphereGrid(r, psis, lams, () => false);
  // The skirt round the edge, down to just over the dome, and the rib.
  const out = { pos: [] as number[], nor: [] as number[], uv: [] as number[] };
  const P = (rr: number, psi: number, lam: number): THREE.Vector3 => new THREE.Vector3(rr * Math.sin(psi), rr * Math.cos(psi) * Math.sin(lam), rr * Math.cos(psi) * Math.cos(lam));
  // The skirt's foot and the underside ride just over the rails (R to R + 0.03).
  const low = R + 0.05;
  const [pa, pb] = [psis[0], psis[psis.length - 1]];
  for (let j = 0; j < lams.length - 1; j++) {
    const [l0, l1] = [lams[j], lams[j + 1]];
    quad(out, P(r, pa, l0), P(low, pa, l0), P(low, pa, l1), P(r, pa, l1));
    quad(out, P(r, pb, l0), P(r, pb, l1), P(low, pb, l1), P(low, pb, l0));
  }
  const [la, lb] = [lams[0], lams[lams.length - 1]];
  quad(out, P(r, pa, la), P(r, pb, la), P(low, pb, la), P(low, pa, la));
  quad(out, P(r, pa, lb), P(low, pa, lb), P(low, pb, lb), P(r, pb, lb));
  // The meeting rib: a ridge of copper along the leaf's inner edge, with a flange over the gap.
  const rib = side > 0 ? pa : pb;
  const ribW = 0.14 / R;
  for (let j = 0; j < lams.length - 1; j++) {
    const [l0, l1] = [lams[j], lams[j + 1]];
    const a = rib - side * ribW;
    const b = rib + side * ribW;
    quad(out, P(r + 0.1, a, l0), P(r + 0.1, b, l0), P(r + 0.1, b, l1), P(r + 0.1, a, l1));
    quad(out, P(r + 0.1, a, l0), P(r + 0.1, a, l1), P(r, a, l1), P(r, a, l0));
    quad(out, P(r + 0.1, b, l0), P(r, b, l0), P(r, b, l1), P(r + 0.1, b, l1));
  }
  const skirt = flatGeometry(out);
  // The leaf's underside, so a view from above never sees through its skirt.
  const under = sphereGrid(low + 0.005, psis, lams, () => false, true);
  const merged = mergeStamped([stamp(face.toNonIndexed(), 'copper', 0.96), stamp(skirt, 'copper', 0.85), stamp(under.toNonIndexed(), 'copper', 0.55)]);
  face.dispose();
  under.dispose();
  return merged;
}

/** Dark enamel: the paint kind's tone taken down to the near-black of a cast iron mount and the fittings of a great refractor. */
const ENAMEL = new THREE.Color(0.17, 0.17, 0.2);

/**
 * The telescope about its declination axis (the origin), pointing along +z:
 * a great refractor's tapered tube with its dew shield, cell ring, three
 * tube rings, finder with its brackets, the eye end's tailpiece, drawtube
 * and focuser knobs, the cradle and declination housing in dark enamel,
 * and the counterweight bar out along -x with its two weights. Cream
 * enamel, brass and dark enamel.
 */
function telescopeGeometry(detail: boolean): THREE.BufferGeometry {
  const seg = detail ? 28 : 16;
  const pieces: THREE.BufferGeometry[] = [];
  const add = (g: THREE.BufferGeometry, kind: Kind, drift = 1, tint?: THREE.Color): void => {
    pieces.push(stamp(g.toNonIndexed(), kind, drift, undefined, tint));
  };
  /** A tube along z from z0 (radius r0) to z1 (radius r1). */
  const tube = (r0: number, r1: number, z0: number, z1: number, kind: Kind, drift = 1, tint?: THREE.Color, n = seg): void => {
    add(new THREE.CylinderGeometry(r1, r0, z1 - z0, n, 1, false).rotateX(Math.PI / 2).translate(0, 0, (z0 + z1) / 2), kind, drift, tint);
  };
  /** A ring (a band) round the tube at z, `w` long, `r` out. */
  const ring = (r: number, z: number, w: number, kind: Kind, drift = 1, tint?: THREE.Color): void => tube(r, r, z - w / 2, z + w / 2, kind, drift, tint);

  // The main tube, tapering from the eye end to the objective, in cream enamel; the objective cell in brass; a dew
  // shield wider than the tube, dark inside, with a brass lip at its mouth.
  tube(0.34, 0.44, -3.3, 5.5, 'paint');
  ring(0.49, 5.55, 0.3, 'gilt');
  tube(0.52, 0.53, 5.6, 7.4, 'paint', 0.97);
  tube(0.48, 0.49, 5.9, 7.38, 'slate', 0.3);
  add(new THREE.TorusGeometry(0.515, 0.035, 8, seg).translate(0, 0, 7.4), 'gilt');
  add(new THREE.CircleGeometry(0.42, seg).translate(0, 0, 5.9), 'slate', 0.25);
  // Three tube rings, brass, each with a boss where the cradle or a stay takes it.
  for (const z of [-1.1, 1.1, 3.4]) {
    ring(0.47, z, 0.24, 'gilt');
    add(new THREE.BoxGeometry(0.2, 0.16, 0.3).translate(0, -0.5, z), 'paint', 1, ENAMEL);
  }
  // The finder along the top of the tube on two brackets: its own tube, dew cap, rings and eyepiece.
  if (detail) {
    tube(0.075, 0.085, 2.4, 4.6, 'paint');
    tube(0.1, 0.1, 4.55, 5.0, 'paint', 0.97);
    for (const z of [2.9, 4.2]) {
      ring(0.1, z, 0.08, 'gilt');
      add(new THREE.BoxGeometry(0.06, 0.26, 0.12).translate(0, 0.46, z), 'paint', 1, ENAMEL);
    }
    tube(0.045, 0.045, 1.95, 2.4, 'paint', 1, ENAMEL, 10);
  }
  // The eye end: a brass tailpiece, the drawtube in dark enamel, the focuser's two knobs either side, the eyepiece.
  tube(0.31, 0.34, -3.8, -3.3, 'gilt');
  tube(0.14, 0.14, -4.4, -3.8, 'paint', 1, ENAMEL);
  ring(0.17, -4.0, 0.12, 'gilt');
  for (const sx of [-1, 1]) add(new THREE.CylinderGeometry(0.1, 0.1, 0.08, 12).rotateZ(Math.PI / 2).translate(sx * 0.27, -0.05, -4.0), 'gilt');
  add(new THREE.CylinderGeometry(0.03, 0.03, 0.5, 8).rotateZ(Math.PI / 2).translate(0, -0.05, -4.0), 'paint', 1, ENAMEL);
  tube(0.07, 0.09, -4.75, -4.4, 'paint', 1, ENAMEL, 12);
  // The cradle: a saddle under the tube in dark enamel, bolted to the declination housing on the axis.
  add(new THREE.BoxGeometry(0.9, 0.3, 2.6).translate(0, -0.58, 0), 'paint', 1, ENAMEL);
  for (const z of [-1.1, 1.1]) add(new THREE.BoxGeometry(0.7, 0.5, 0.26).translate(0, -0.48, z), 'paint', 1, ENAMEL);
  add(new THREE.CylinderGeometry(0.3, 0.3, 1.0, seg).rotateZ(Math.PI / 2).translate(0, -0.6, 0), 'paint', 1, ENAMEL);
  add(new THREE.CylinderGeometry(0.34, 0.34, 0.12, seg).rotateZ(Math.PI / 2).translate(0.56, -0.6, 0), 'gilt');
  // The counterweight bar out along the declination axis, two weights on it and a brass knob at its end.
  add(new THREE.CylinderGeometry(0.06, 0.06, 2.6, 10).rotateZ(Math.PI / 2).translate(-1.8, -0.6, 0), 'paint', 1, ENAMEL);
  for (const x of [-1.75, -2.25]) add(new THREE.CylinderGeometry(0.33, 0.33, 0.26, seg).rotateZ(Math.PI / 2).translate(x, -0.6, 0), 'paint', 1, ENAMEL);
  add(new THREE.SphereGeometry(0.08, 8, 6).translate(-3.1, -0.6, 0), 'gilt');
  return mergeStamped(pieces);
}

/**
 * The ribs and purlins inside the dome, and the shutter rails outside it,
 * as chains of small boxes laid along their arcs: `S(r, az, pol)` is a
 * point at radius r, azimuth az about the dome's axis and polar angle pol
 * from the apex.
 */
function domeIronwork(detail: boolean): { ribs: THREE.BufferGeometry; rails: THREE.BufferGeometry } {
  const R = OBSERVATORY.dome;
  const ps = Math.asin(OBSERVATORY.slitHalf / R);
  const S = (r: number, az: number, pol: number): THREE.Vector3 => new THREE.Vector3(r * Math.sin(pol) * Math.sin(az), r * Math.cos(pol), r * Math.sin(pol) * Math.cos(az));
  const m = new THREE.Matrix4();
  const n = new THREE.Vector3();
  const t = new THREE.Vector3();
  const b = new THREE.Vector3();
  /** A box of w by d laid along the arc from `from` to `to` (points on the sphere), its depth along the radius. */
  const bar = (out: THREE.BufferGeometry[], from: THREE.Vector3, to: THREE.Vector3, w: number, d: number): void => {
    const mid = from.clone().add(to).multiplyScalar(0.5);
    n.copy(mid).normalize();
    t.subVectors(to, from);
    const len = t.length() + 0.02;
    t.normalize();
    b.crossVectors(n, t).normalize();
    m.makeBasis(b, t, n).setPosition(mid);
    out.push(new THREE.BoxGeometry(w, len, d).applyMatrix4(m));
  };
  const ribs: THREE.BufferGeometry[] = [];
  // Ribs stand clear under the lining (never in its surface), their outer face a hand inside it.
  const ri = R - SHELL - 0.2;
  const steps = detail ? 14 : 8;
  // Meridian ribs every thirty degrees, none through the slit (the front), the back one starting past the slit's head.
  for (let kk = 1; kk < 12; kk++) {
    const az = (kk * Math.PI) / 6;
    const pol0 = kk === 6 ? 0.42 : 0.12;
    const pol1 = Math.PI / 2 - 0.04;
    for (let i = 0; i < steps; i++) bar(ribs, S(ri, az, pol0 + ((pol1 - pol0) * i) / steps), S(ri, az, pol0 + ((pol1 - pol0) * (i + 1)) / steps), 0.16, 0.16);
  }
  // Two purlin rings between the ribs, broken at the slit.
  for (const pol of [0.62, 1.12]) {
    const nseg = detail ? 48 : 28;
    for (let i = 0; i < nseg; i++) {
      const a0 = (i / nseg) * Math.PI * 2;
      const a1 = ((i + 1) / nseg) * Math.PI * 2;
      const mid = (a0 + a1) / 2;
      // Across the slit the ring stops: the slit is the band |x| < slitHalf on the front.
      if (Math.abs(R * Math.sin(pol) * Math.sin(mid)) < OBSERVATORY.slitHalf + 0.25 && Math.cos(mid) > 0) continue;
      bar(ribs, S(ri, a0, pol), S(ri, a1, pol), 0.12, 0.1);
    }
  }
  // The shutter rails: a dark iron rail either side of the slit on the copper, the leaves ride over them.
  const rails: THREE.BufferGeometry[] = [];
  const P = (r: number, psi: number, lam: number): THREE.Vector3 => new THREE.Vector3(r * Math.sin(psi), r * Math.cos(psi) * Math.sin(lam), r * Math.cos(psi) * Math.cos(lam));
  const nr = detail ? 30 : 16;
  for (const side of [-1, 1]) {
    const psi = side * (ps + 0.5 / R);
    for (let i = 0; i < nr; i++) {
      const l0 = SLIT_FROM - 0.25 / R + ((SLIT_TO - SLIT_FROM + 0.6 / R) * i) / nr;
      const l1 = SLIT_FROM - 0.25 / R + ((SLIT_TO - SLIT_FROM + 0.6 / R) * (i + 1)) / nr;
      bar(rails, P(R + 0.005, psi, l0), P(R + 0.005, psi, l1), 0.1, 0.05);
    }
  }
  return { ribs: mergeGeometries(ribs.map((g) => g.toNonIndexed()), false)!, rails: mergeGeometries(rails.map((g) => g.toNonIndexed()), false)! };
}

// ---------------------------------------------------------------- the building

export function makeObservatory(k: Kit, o: ObservatoryOptions): Observatory {
  const detail = o.quality === 'high';
  const g = new Gothic(k, rng(o.seed ?? 'observatory'), detail);
  const O = OBSERVATORY;
  const facing = o.facing ?? Math.PI / 4;
  const D = 0.5;
  const faceW = 2 * O.drum * Math.tan(Math.PI / O.faces);
  const corner = O.drum / Math.cos(Math.PI / O.faces);
  /** Face s of the drum (x along the face, y up, z out); face 0 carries the door and faces `facing`. */
  const face = (s: number, r = O.drum): THREE.Matrix4 => M(0, 0, 0, facing + (s * 2 * Math.PI) / O.faces).multiply(M(0, 0, r));
  const plinthH = 0.8;

  // ---------------------------------------------------------------- the drum
  // A limestone plinth, twelve brick faces between limestone pilasters, a string under the windows, a corbelled
  // cornice. Every other face has a lancet; the door face its doorway under two orders and a hood.
  g.add('limestone', new THREE.CylinderGeometry(corner + 0.3, corner + 0.3, plinthH, O.faces).rotateY(facing + Math.PI / O.faces).translate(0, plinthH / 2, 0));
  g.add('limestone', new THREE.CylinderGeometry(corner + 0.45, corner + 0.45, 0.25, O.faces).rotateY(facing + Math.PI / O.faces).translate(0, plinthH - 0.125, 0));
  const sill = 3.4;
  for (let s = 0; s < O.faces; s++) {
    const F = face(s);
    const openings: Opening[] = [];
    if (s === 0) {
      const door: Opening = { u: 0, w: 1.6, y0: plinthH, y1: plinthH + 2.3, pointed: true, lights: 1 };
      openings.push(door);
      g.add('brick', piercedWall(faceW, O.drumTop - plinthH, D, [outline({ ...door, y0: 0, y1: door.y1 - plinthH })]), F.clone().multiply(M(0, plinthH, -D)), 0.05);
      g.doorway(F, door, D, plinthH, 2);
      // The door itself: dark timber deep in the arch, under the lit fanlight the doorway's pane gives.
      g.box('louvre', door.w, 2.1, 0.08, F.clone().multiply(M(0, plinthH + 1.05, -D + 0.12)), 0.02);
      // A hood over the door on two corbels.
      g.box('limestone', door.w + 1.4, 0.22, 0.9, F.clone().multiply(M(0, plinthH + 2.3 + door.w * Math.sin(Math.PI / 3) + 0.55, 0.45)));
      for (const u of [-1, 1]) g.box('limestone', 0.3, 0.5, 0.7, F.clone().multiply(M(u * (door.w / 2 + 0.45), plinthH + 2.3 + door.w * Math.sin(Math.PI / 3) + 0.2, 0.35)));
      // Three steps down to the lawn, between low cheeks.
      for (let i = 0; i < 3; i++) g.box('limestone', door.w + 1.6, plinthH / 3, 0.36, F.clone().multiply(M(0, (plinthH / 3) * (2.5 - i), 0.3 + 0.18 + i * 0.36)));
      // The brass plate by the door, on the wall to the right, with a small lantern on a bracket over it.
      const px = door.w / 2 + 1.0;
      g.box('limestone', 0.7, 0.9, 0.06, F.clone().multiply(M(px, 2.1, 0.03)));
      g.box('brass', 0.56, 0.76, 0.03, F.clone().multiply(M(px, 2.1, 0.07)));
      g.box('slate', 0.08, 0.08, 0.5, F.clone().multiply(M(px, 2.9, 0.25)), 0.4);
      g.box('slate', 0.3, 0.06, 0.3, F.clone().multiply(M(px, 2.78, 0.42)), 0.4);
      g.box('brass', 0.22, 0.2, 0.22, F.clone().multiply(M(px, 2.65, 0.42)));
      g.box('slate', 0.26, 0.05, 0.26, F.clone().multiply(M(px, 2.53, 0.42)), 0.4);
    } else {
      if (s % 2 === 0) openings.push({ u: 0, w: 0.9, y0: sill, y1: sill + 2.6, pointed: true, lights: 1, lit: 0.5 });
      g.wall(F, faceW, plinthH, O.drumTop - plinthH, D, openings, 0.05);
    }
    // A pilaster of limestone at each angle, and the string under the sills.
    const A = M(0, 0, 0, facing + ((s + 0.5) * 2 * Math.PI) / O.faces).multiply(M(0, 0, corner - 0.12));
    g.box('limestone', 0.56, O.drumTop - plinthH - 0.2, 0.34, A.clone().multiply(M(0, plinthH + (O.drumTop - plinthH - 0.2) / 2, 0)));
    g.box('limestone', faceW - 0.4, 0.18, 0.2, F.clone().multiply(M(0, sill - 0.09, 0.1)));
  }
  // The cornice: a corbel table and a moulded limestone ring at the top, the dome's copper curb on it.
  if (detail) for (let s = 0; s < O.faces; s++) for (let u = -faceW / 2 + 0.5; u <= faceW / 2 - 0.49; u += 0.6) g.box('limestone', 0.26, 0.4, 0.4, face(s).multiply(M(u, O.drumTop - 0.42, 0.2)));
  g.add('limestone', new THREE.CylinderGeometry(corner + 0.5, corner + 0.2, 0.5, O.faces).rotateY(facing + Math.PI / O.faces).translate(0, O.drumTop + 0.25, 0));
  g.add('limestone', new THREE.CylinderGeometry(corner + 0.55, corner + 0.55, 0.2, O.faces).rotateY(facing + Math.PI / O.faces).translate(0, O.drumTop + 0.6, 0));
  // The interior: a dark core so no window shows the sky through, a floor, and the pier under the telescope.
  g.add('slate', new THREE.CylinderGeometry(O.drum - 0.6, O.drum - 0.6, O.drumTop - plinthH, O.faces).translate(0, (plinthH + O.drumTop) / 2, 0), undefined, 0);
  // The pier, its cast iron head and the polar housing of a German equatorial mount, leaning back to the pole,
  // carrying the declination axis (the telescope's pivot) at its top.
  const pierTop = O.centre - 1.0;
  const pivot = new THREE.Vector3(0, O.centre + 0.2, -2.2);
  const headTop = new THREE.Vector3(0, pierTop + 0.7, -1.5);
  g.add('limestone', new THREE.CylinderGeometry(0.75, 0.95, pierTop, 16).translate(0, pierTop / 2, 0), M(0, 0, 0, facing).multiply(M(0, 0, -1.5)));
  g.add('limestone', new THREE.CylinderGeometry(0.95, 0.75, 0.3, 16).translate(0, pierTop - 0.15, 0), M(0, 0, 0, facing).multiply(M(0, 0, -1.5)));
  g.box('slate', 1.4, 0.7, 1.4, M(0, 0, 0, facing).multiply(M(0, pierTop + 0.35, -1.5)), 0);
  {
    const axis = pivot.clone().sub(headTop);
    const len = axis.length();
    const tilt = Math.atan2(-axis.z, axis.y);
    const housing = new THREE.CylinderGeometry(0.36, 0.42, len + 0.3, 20).translate(0, len / 2, 0).rotateX(-tilt).translate(headTop.x, headTop.y, headTop.z);
    g.add('slate', housing, M(0, 0, 0, facing), 0);
    g.add('slate', new THREE.CylinderGeometry(0.4, 0.4, 0.9, 20).rotateZ(Math.PI / 2).translate(pivot.x, pivot.y, pivot.z), M(0, 0, 0, facing), 0);
  }

  // ---------------------------------------------------------------- the dome
  const dome = M(0, O.centre, 0, facing);
  const curbSeg = detail ? 64 : 40;
  const curbH = O.centre - (O.drumTop + 0.7);
  g.add('copper', metresUv(new THREE.CylinderGeometry(O.dome + 0.1, O.dome + 0.1, curbH, curbSeg, 1, true), 2 * Math.PI * (O.dome + 0.1), curbH).translate(0, (O.centre + O.drumTop + 0.7) / 2, 0), undefined, 0);
  g.add('copper', new THREE.TorusGeometry(O.dome + 0.1, 0.09, 8, curbSeg).rotateX(Math.PI / 2).translate(0, O.centre - 0.02, 0), undefined, 0);
  const shell = domeShell(detail);
  g.add('copper', shell.outer, dome);
  g.add('copper', shell.cheeks, dome, 0.1);
  g.add('glow', shell.lining, dome);
  // The ribs and purlins inside, darker in the same lamplight (the lining's tone drives its light); the rails outside.
  const iron = domeIronwork(detail);
  k.tint.setScalar(0.4);
  k.add(MAT.glow, iron.ribs, dome, false);
  k.tint.setScalar(1);
  g.add('slate', iron.rails, dome, 0);
  // A finial at the apex would stand in the slit's way: the dome ends in a small copper boss behind the slit's head.
  g.add('copper', new THREE.SphereGeometry(0.28, 10, 8), dome.clone().multiply(M(0, O.dome * Math.cos(0.42), -O.dome * Math.sin(0.42))), 0.1);

  // ---------------------------------------------------------------- its own objects
  const group = new THREE.Group();
  group.name = 'campus:observatory';
  const base = k.base.clone().multiply(dome);
  // The shutter: both leaves in one geometry, each swung in place about the slit's axis as it opens.
  const leaves = [leaf(1, detail), leaf(-1, detail)];
  const shutterGeo = mergeStamped(leaves.map((l) => l.clone()));
  for (const l of leaves) l.dispose();
  const rest = Float32Array.from(shutterGeo.attributes.position.array as Float32Array);
  const restN = Float32Array.from(shutterGeo.attributes.normal.array as Float32Array);
  // Which leaf each vertex belongs to: the first leaf's vertices come first.
  const firstLeafCount = (leaves[0].attributes.position as THREE.BufferAttribute).count;
  const shutter = new THREE.Mesh(shutterGeo, o.masonry);
  shutter.name = 'campus:shutter';
  shutter.castShadow = shutter.receiveShadow = true;
  shutter.applyMatrix4(base);
  shutter.matrixAutoUpdate = false;
  shutter.updateMatrix();
  shutterGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), O.dome + 0.6);
  group.add(shutter);

  const telescope = new THREE.Mesh(telescopeGeometry(detail), o.masonry);
  telescope.name = 'campus:telescope';
  telescope.castShadow = telescope.receiveShadow = false;
  telescope.rotation.order = 'YXZ';
  const mount = new THREE.Group();
  mount.applyMatrix4(k.base.clone().multiply(M(0, 0, 0, facing)).multiply(M(pivot.x, pivot.y, pivot.z)));
  mount.add(telescope);
  group.add(mount);

  // The dome's pick proxy: the sphere over the drum, never drawn.
  const pick = new THREE.Mesh(new THREE.SphereGeometry(O.dome + 0.3, 16, 12), new THREE.MeshBasicMaterial({ visible: false }));
  pick.name = 'campus:observatory-pick';
  pick.visible = false;
  pick.applyMatrix4(base);
  group.add(pick);
  const pickables = new Map<THREE.Object3D, string>([[pick, SCHOOL_MASTER_ROUTE]]);

  // ---------------------------------------------------------------- the state
  const uniforms = o.masonry.userData as { slitLit?: { value: number }; plateLit?: { value: number } };
  let state: ObservatoryState = { training: false, masterTrusted: false, version: 0 };
  let open = 0;
  let shown = -1;
  let turn = 0;
  const rot = new THREE.Matrix3();
  const v = new THREE.Vector3();
  const setLeaves = (t: number): void => {
    // Leaf one (on +x) swings to +x, which about the slit's axis is a negative turn; its pair the other way.
    const pos = shutterGeo.attributes.position as THREE.BufferAttribute;
    const nor = shutterGeo.attributes.normal as THREE.BufferAttribute;
    const ease = t * t * (3 - 2 * t);
    for (const [side, from, to] of [
      [-1, 0, firstLeafCount],
      [1, firstLeafCount, pos.count],
    ] as Array<[number, number, number]>) {
      rot.setFromMatrix4(new THREE.Matrix4().makeRotationZ(side * LEAF_SWING * ease));
      for (let i = from; i < to; i++) {
        v.set(rest[i * 3], rest[i * 3 + 1], rest[i * 3 + 2]).applyMatrix3(rot);
        pos.setXYZ(i, v.x, v.y, v.z);
        v.set(restN[i * 3], restN[i * 3 + 1], restN[i * 3 + 2]).applyMatrix3(rot);
        nor.setXYZ(i, v.x, v.y, v.z);
      }
    }
    pos.needsUpdate = true;
    nor.needsUpdate = true;
    shutterGeo.computeBoundingBox();
  };
  /** Where this version looks: a different piece of sky for each version of the master. */
  const aim = (): { altitude: number; azimuth: number } => {
    const r = rng(`${o.seed ?? 'observatory'}:${state.version}`);
    return { altitude: 0.78 + 0.34 * r(), azimuth: (r() - 0.5) * 0.3 };
  };
  let altitude = 0.95;
  let azimuth = 0;
  const point = (): void => {
    telescope.rotation.set(-altitude, azimuth, 0);
  };
  const apply = (): void => {
    if (uniforms.slitLit) uniforms.slitLit.value = open;
    if (uniforms.plateLit) uniforms.plateLit.value = state.masterTrusted ? 1 : 0;
  };
  setLeaves(0);
  point();
  apply();

  return {
    group,
    shutter,
    telescope,
    pickables,
    setState(s) {
      const retarget = s.version !== state.version;
      state = { ...s };
      if (retarget) ({ altitude, azimuth } = aim());
      apply();
    },
    update(dt) {
      const want = state.training ? 1 : 0;
      if (open !== want) {
        open = THREE.MathUtils.clamp(open + (Math.sign(want - open) * dt) / SHUTTER_SECONDS, 0, 1);
        apply();
      }
      // The leaves move in steps of a hundredth: no geometry write while they rest.
      const step = Math.round(open * 100);
      if (step !== shown) {
        shown = step;
        setLeaves(open);
      }
      if (state.training) {
        // The telescope tracks: a slow nod in altitude and a hunt across the slit, as a long exposure follows the sky.
        turn += dt;
        const { altitude: a0, azimuth: z0 } = aim();
        altitude = a0 + 0.12 * Math.sin(turn / 9);
        azimuth = z0 + 0.1 * Math.sin(turn / 13 + 1);
        point();
      }
    },
    view: () => ({ open, training: state.training, lit: state.masterTrusted, version: state.version, altitude, azimuth }),
    dispose() {
      shutterGeo.dispose();
      telescope.geometry.dispose();
      pick.geometry.dispose();
      (pick.material as THREE.Material).dispose();
    },
  };
}
