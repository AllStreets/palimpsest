/**
 * A ceremonial ribbon (Phase 3 Task 16): satin in a firm's colour, tied
 * round a floor across its face, a little above mid-floor, sagging between
 * the corners where it is pinned, with a bow at the corner that faces the
 * street: a knot, two loops and two tails cut to a V. Sewn as strips along
 * centripetal Catmull-Rom curves, every ribbon in the city merged into one
 * geometry with its colour per vertex and a `sway` weight (0 where it is
 * pinned, up to 1 mid-span and at the tails' ends), which the vertex shader
 * moves on a slow 0.3 Hz swell. Pure geometry, so it is tested in Node.
 */
import * as THREE from 'three';

/** One ribbon to sew: round a square floor plan `half` from its centre (in the world), turned `ry`, its band centred at `y`. */
export interface RibbonSpec {
  centre: THREE.Vector3;
  ry: number;
  half: number;
  y: number;
  colour: THREE.Color;
}

export const RIBBON = {
  /** The band's width, the bow's ribbon, how far the band stands off the face, and its sag mid-span. */
  band: 0.55,
  bow: 0.4,
  off: 0.12,
  sag: 0.38,
  /** The tails' length, the loops' reach. */
  tail: 1.9,
  loop: 0.95,
  /** The sway: its frequency in Hz and its reach in metres. */
  hz: 0.3,
  reach: 0.05,
} as const;

const UP = new THREE.Vector3(0, 1, 0);

class Sewer {
  pos: number[] = [];
  nor: number[] = [];
  col: number[] = [];
  sway: number[] = [];
  idx: number[] = [];
  /**
   * A strip along `pts`, `width` wide across `across(i)`, each point's sway
   * weight `w(i)`. Normals face the strip's front (tangent cross across).
   */
  strip(pts: THREE.Vector3[], across: (i: number) => THREE.Vector3, width: number | ((i: number) => number), w: (i: number) => number, colour: THREE.Color, closed = false): void {
    const base = this.pos.length / 3;
    const n = pts.length;
    for (let i = 0; i < n; i++) {
      const a = pts[i];
      const t = pts[closed ? (i + 1) % n : Math.min(n - 1, i + 1)].clone().sub(pts[closed ? (i - 1 + n) % n : Math.max(0, i - 1)]).normalize();
      const x = across(i).clone().normalize();
      const wd = typeof width === 'number' ? width : width(i);
      const nr = t.clone().cross(x).normalize();
      for (const s of [-0.5, 0.5]) {
        const p = a.clone().addScaledVector(x, s * wd);
        this.pos.push(p.x, p.y, p.z);
        this.nor.push(nr.x, nr.y, nr.z);
        this.col.push(colour.r, colour.g, colour.b);
        this.sway.push(w(i));
      }
    }
    const segs = closed ? n : n - 1;
    for (let i = 0; i < segs; i++) {
      const a = base + i * 2;
      const b = base + ((i + 1) % n) * 2;
      this.idx.push(a, a + 1, b, a + 1, b + 1, b);
    }
  }
  geometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('sway', new THREE.Float32BufferAttribute(this.sway, 1));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

/** The corner of a square plan that faces the street the city is seen from (+z, then +x), in the plan's own frame. */
function streetCorner(ry: number): [number, number] {
  let best: [number, number] = [1, 1];
  let score = -Infinity;
  for (const [sx, sz] of [[1, 1], [-1, 1], [1, -1], [-1, -1]] as Array<[number, number]>) {
    const v = new THREE.Vector3(sx, 0, sz).applyAxisAngle(UP, ry);
    const k = v.z + 0.3 * v.x;
    if (k > score) {
      score = k;
      best = [sx, sz];
    }
  }
  return best;
}

/** Sews one ribbon into `s`, in the world. */
function sew(s: Sewer, r: RibbonSpec): void {
  const R = r.half + RIBBON.off;
  const turn = new THREE.Matrix4().makeRotationY(r.ry).setPosition(r.centre.x, r.y, r.centre.z);
  const world = (p: THREE.Vector3): THREE.Vector3 => p.clone().applyMatrix4(turn);
  // The band: pinned at each corner, sagging between, a corner held tight by points close either side of it.
  const corners: Array<[number, number]> = [[R, R], [-R, R], [-R, -R], [R, -R]];
  const ctrl: THREE.Vector3[] = [];
  corners.forEach(([x0, z0], i) => {
    const [x1, z1] = corners[(i + 1) % 4];
    for (const t of [0, 0.04, 0.25, 0.5, 0.75, 0.96]) {
      const drop = RIBBON.sag * 4 * t * (1 - t);
      // A little fuller mid-span: the cloth bellies out as it sags.
      const out = 0.05 * 4 * t * (1 - t);
      const x = x0 + (x1 - x0) * t;
      const z = z0 + (z1 - z0) * t;
      const len = Math.hypot(x, z) || 1;
      ctrl.push(new THREE.Vector3(x + (x / len) * out, -drop, z + (z / len) * out));
    }
  });
  const curve = new THREE.CatmullRomCurve3(ctrl, true, 'centripetal');
  const n = 160;
  const pts = curve.getSpacedPoints(n).slice(0, n);
  const sideT = (i: number): number => {
    // How far along its side a sample is, from the nearest pinned corner: 0 at a corner, 1 mid-span.
    const u = ((i / n) * 4) % 1;
    return 4 * u * (1 - u);
  };
  s.strip(pts.map(world), () => UP, RIBBON.band, (i) => sideT(i), r.colour, true);

  // The bow, at the street corner: tied over the band, facing out along the diagonal.
  const [sx, sz] = streetCorner(r.ry);
  const out = new THREE.Vector3(sx, 0, sz).normalize();
  const side = new THREE.Vector3(-sz, 0, sx).normalize();
  const knot = new THREE.Vector3(sx * R, 0, sz * R).addScaledVector(out, 0.08);
  // Its ribbon's face turned a little up toward the eye, so the loops show their satin, not their edges.
  const face = out.clone().multiplyScalar(Math.cos(0.6)).addScaledVector(UP, -Math.sin(0.6));
  // The knot: a short wrap round the band.
  const wrap: THREE.Vector3[] = [];
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    wrap.push(knot.clone().addScaledVector(UP, Math.cos(a) * 0.17).addScaledVector(out, Math.sin(a) * 0.09 + 0.05));
  }
  s.strip(wrap.map(world), () => side.clone().applyAxisAngle(UP, r.ry), 0.16, () => 0, r.colour, true);
  // Two loops, one each way: a teardrop from the knot out along the face and back, a little above it.
  for (const dir of [-1, 1]) {
    const L = RIBBON.loop;
    const c = new THREE.CatmullRomCurve3(
      [
        knot.clone().addScaledVector(out, 0.1),
        knot.clone().addScaledVector(side, dir * L * 0.55).addScaledVector(UP, 0.24).addScaledVector(out, 0.14),
        knot.clone().addScaledVector(side, dir * L).addScaledVector(UP, 0.08).addScaledVector(out, 0.12),
        knot.clone().addScaledVector(side, dir * L * 0.6).addScaledVector(UP, -0.14).addScaledVector(out, 0.13),
      ],
      true,
      'centripetal',
    );
    const lp = c.getSpacedPoints(28).slice(0, 28);
    s.strip(lp.map(world), () => face.clone().applyAxisAngle(UP, r.ry), RIBBON.bow, (i) => 0.25 * Math.sin((i / 28) * Math.PI), r.colour, true);
  }
  // Two tails hanging from the knot, splaying a little, each cut to a V at its end (its width narrowing to nothing).
  for (const dir of [-1, 1]) {
    const tp: THREE.Vector3[] = [];
    const m = 14;
    for (let i = 0; i <= m; i++) {
      const t = i / m;
      tp.push(knot.clone().addScaledVector(out, 0.12 + 0.06 * t).addScaledVector(side, dir * (0.06 + 0.32 * t)).addScaledVector(UP, -RIBBON.tail * t));
    }
    s.strip(tp.map(world), () => side.clone().applyAxisAngle(UP, r.ry), (i) => RIBBON.bow * (i < m ? 1 : 0.15), (i) => Math.min(1, (i / m) * 1.2), r.colour);
  }
}

/**
 * A firm's colour as satin: its hue and saturation, its lightness lifted or
 * held to a cloth's albedo (HSL L 0.35 to 0.45), so a dark mark colour's
 * shaded side never goes black against lit glass.
 */
export function clothColour(c: THREE.Color): THREE.Color {
  const hsl = c.getHSL({ h: 0, s: 0, l: 0 });
  return new THREE.Color().setHSL(hsl.h, hsl.s, Math.min(0.45, Math.max(0.35, hsl.l)));
}

/** The sheen over satin of these colours: their mean, lightened toward white. */
export function sheenOf(colours: ReadonlyArray<THREE.Color>): THREE.Color {
  if (!colours.length) return new THREE.Color(0.85, 0.82, 0.78);
  const m = new THREE.Color(0, 0, 0);
  for (const c of colours) m.add(c);
  m.multiplyScalar(1 / colours.length);
  const hsl = clothColour(m).getHSL({ h: 0, s: 0, l: 0 });
  return new THREE.Color().setHSL(hsl.h, hsl.s * 0.7, 0.72);
}

/** Every ribbon in the city as one geometry, in the world, each in its colour as cloth. */
export function ribbonGeometry(specs: ReadonlyArray<RibbonSpec>): THREE.BufferGeometry {
  const s = new Sewer();
  for (const r of specs) sew(s, { ...r, colour: clothColour(r.colour) });
  return s.geometry();
}

/**
 * Satin: a soft sheen across the weave, a little gloss, its colour per
 * vertex; never an emitter. The vertex shader sways it on `uTime`.
 */
export function ribbonMaterial(): THREE.MeshPhysicalMaterial & { userData: { time: { value: number } } } {
  const m = new THREE.MeshPhysicalMaterial({
    vertexColors: true,
    roughness: 0.46,
    metalness: 0,
    sheen: 1,
    sheenRoughness: 0.32,
    sheenColor: new THREE.Color(0.85, 0.82, 0.78),
    // The sky's fill on the face the sun leaves: satin is never black in shade.
    envMapIntensity: 1.5,
    side: THREE.DoubleSide,
  });
  m.name = 'milestone-ribbon';
  const time = { value: 0 };
  m.userData.time = time;
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = time;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float sway;\nuniform float uTime;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>\ntransformed += objectNormal * sway * ${RIBBON.reach.toFixed(3)} * sin(6.2831853 * ${RIBBON.hz.toFixed(2)} * uTime + position.x * 0.21 + position.z * 0.17);`,
      );
  };
  m.customProgramCacheKey = () => 'ribbon-sway';
  return m as THREE.MeshPhysicalMaterial & { userData: { time: { value: number } } };
}
