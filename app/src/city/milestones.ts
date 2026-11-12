/**
 * The skyline in the city (Phase 3 Task 14, ruling 11, Decision 3): the
 * engine's milestones, shown on the towers they name and derived from
 * nothing else.
 *
 * - `skyline`, lit: the tower with the greatest earned height above its
 *   datum carries a guyed mast on its true top (above any lens or needle
 *   crown). The mast is the needle's (crowns.ts makeSpire) on a battered
 *   footing, with two levels of stays to anchor plates on the roof, three
 *   service galleries each ringed with small lamps, and a warm obstruction
 *   lamp at its tip. The lamps are real emitters under the bloom threshold,
 *   breathing over four seconds, and from home the tip holds a two pixel
 *   point of the same warm light, so the honour reads across the city
 *   without a halo.
 * - `skyline`, passed: the mast stays, its lamps dark glass.
 * - `founding-skyline`: the tallest tower by total height wears a bronze
 *   sleeve on the mast's footing, and, while its mast is not lit, a bronze
 *   finial over the dark lamp. The tower holding both keeps one mast, lit,
 *   in its sleeve.
 *
 * Each part is built once per quality from a Kit (procedural, no asset) and
 * drawn as one instanced mesh city-wide: the mast and its stays in four
 * calls, the lamps in two, the bronze in two and the far point in one. Sized `spireHeight(top)`.
 */
import * as THREE from 'three';

import { crownFor } from '../../../shared/silhouette.js';
import { layoutTower, type TowerLayout } from '../../../shared/tower-layout.js';
import type { Milestone, MilestoneKind, Quarter, TowerSpec } from '../../../shared/types.js';
import { LAYER, setLayers } from './lod.js';
import { hash01 } from './construction.js';
import { makeLitScaffold, type LitScaffold } from './scaffold-kit.js';
import { RIBBON, ribbonGeometry, ribbonMaterial, sheenOf, type RibbonSpec } from './ribbon.js';
import { makeSpire } from './tower/crowns.js';
import { Kit, lathe, M, type MatKey, type TowerMaterials } from './tower/kit.js';

/** A tower as the city built it: its group, its layout, its roof's half width and its crown. */
export interface TowerPiece {
  group: THREE.Object3D;
  layout: TowerLayout;
  /** Half the top floor's width, centre to face. */
  half: number;
  /** The height of what stands on the roof already (an agent tower's lens or needle), or 0. */
  crown: number;
  /** The tower's true top in the world: the top floor's roof centre, raised past its crown. */
  roof(): THREE.Vector3;
  /** A floor by id, in the tower's frame: its plan centre, its turn, its foot and height, and its half width; null when the tower has no such floor. */
  floor(id: string): { cx: number; cz: number; ry: number; y0: number; h: number; half: number; index: number } | null;
}

/** A district tower or a quarter as placed, for findTowerPiece. */
export interface PlacedDistrict {
  spec: TowerSpec;
  object: THREE.Object3D;
}
export interface PlacedQuarter {
  quarter: Quarter;
  object: THREE.Object3D;
}

/**
 * The tower `towerId` names: a district tower by `<repo>#founding`, an agent
 * tower by `agent:<id>` (agentTowerId), or null when none stands.
 */
export function findTowerPiece(towerId: string, districts: ReadonlyArray<PlacedDistrict>, quarters: ReadonlyArray<PlacedQuarter>): TowerPiece | null {
  let spec: TowerSpec | null = null;
  let group: THREE.Object3D | null = null;
  const d = districts.find((x) => x.spec.id === towerId);
  if (d) {
    spec = d.spec;
    group = d.object;
  } else {
    for (const q of quarters) {
      const t = q.quarter.towers.find((x) => x.id === towerId);
      if (!t) continue;
      spec = t;
      group = q.object.getObjectByName(`tower:${towerId}`) ?? null;
      break;
    }
  }
  // A tower the scene has taken out of the city (disconnected, sold, rebuilt) carries nothing.
  if (!spec || !group || !group.parent) return null;
  const picks = group.getObjectByName('tower:picks');
  if (!picks || picks.children.length === 0) return null;
  // The top floor's proxy (the root's, before any floor): its centre and width are the roof's.
  let top = picks.children[0];
  for (const p of picks.children) if (p.position.y + p.scale.y / 2 > top.position.y + top.scale.y / 2) top = p;
  const layout = layoutTower(spec);
  const earned = spec.floors.filter((f, i) => i >= spec.datumIndex && !f.founding).length;
  const crown = spec.kind === 'agent' && earned > 0 ? crownFor(spec.silhouette ?? 'plain', earned).height : 0;
  // The root's pick proxy is built 3 m wider than its top on every side (build.ts rootPick), so a bare root's roof is 3 m in from it.
  const half = spec.floors.length ? top.scale.x / 2 : top.scale.x / 2 - 3;
  const cx = top.position.x;
  const cz = top.position.z;
  const g = group;
  return {
    group: g,
    layout,
    half,
    crown,
    roof() {
      g.updateWorldMatrix(true, false);
      return g.localToWorld(new THREE.Vector3(cx, layout.top + crown, cz));
    },
    floor(id) {
      const index = layout.floors.findIndex((f) => f.floor.id === id);
      if (index < 0) return null;
      const { y0, h } = layout.floors[index];
      // The floor's own pick proxy: a unit box scaled to the floor's slice, centred on it.
      const p = picks.children.find((o) => Math.abs(o.position.y - (y0 + h / 2)) < 1e-3 && Math.abs(o.scale.y - h) < 1e-3);
      if (!p) return null;
      return { cx: p.position.x, cz: p.position.z, ry: p.rotation.y, y0, h, half: p.scale.x / 2, index };
    },
  };
}

/** A spire's height on a tower whose roof stands `top` metres up: 8% of it, never under 12 m. */
export function spireHeight(top: number): number {
  return Math.max(12, 0.08 * top);
}

/**
 * The mast as built, before it is scaled to its tower: its height, the
 * spread of its stays' anchors, its warm lamp colour (linear, times the
 * exposure stays under the bloom threshold at the top of a breath) and the
 * breath's low and high.
 */
export const SPIRE = {
  height: 16,
  anchor: 4.2,
  lamp: [1.0, 0.42, 0.11] as [number, number, number],
  breath: [0.5, 1.06] as [number, number],
  /** Seconds per breath. */
  period: 4,
  /** The far point's size in pixels. */
  point: 3.5,
} as const;

/**
 * The festoon's bulbs (Task 15): warm tungsten, linear, at their brightest
 * under the bloom threshold after the exposure; each burns at its own level
 * and wavers a little (hash01 per bulb), and about one in sixteen is dead,
 * as on any string that has hung a week on a site.
 */
export const FESTOON = {
  bulb: [1.0, 0.5, 0.18] as [number, number, number],
  radius: 0.12,
  dead: 0.06,
} as const;

/** How a milestone shows in the city now (tests and captures). */
export interface MilestoneShow {
  kind: MilestoneKind;
  towerId: string;
  lit: boolean;
  /** The world height of the spire's foot: the tower's true top. */
  y: number;
  height: number;
  /** The tip in the world. */
  tip: number[];
}

export interface Milestones {
  group: THREE.Group;
  /** The lit lamps' material and the far point's (tests). */
  lamp: THREE.MeshBasicMaterial;
  point: THREE.PointsMaterial;
  /**
   * Stands each milestone on its tower; one whose `until` is past at `now`
   * shows nothing. Returns when the next one still standing ends (ms since
   * the epoch), or null: the caller sets them again then, so it goes dark.
   */
  set(ms: ReadonlyArray<Milestone>, towers: (towerId: string) => TowerPiece | null, now?: number, o?: { fallen?: ReadonlySet<string> }): number | null;
  update(dt: number, clock: number): void;
  shows(): Map<string, MilestoneShow>;
  dispose(): void;
}

// ---------------------------------------------------------------- the mast's own geometry

/** The mast's radius at height y, as makeSpire builds it at SPIRE.height (its footing, three telescoping sections). */
function mastAt(y: number): number {
  const h = SPIRE.height;
  const footing = Math.min(1.8, h * 0.1);
  const base = 2.2;
  const span = h - 0.5 - 0.42 - footing;
  const parts = [0.42, 0.33, 0.25];
  let y0 = footing;
  let r = base * 0.5;
  for (let i = 0; i < parts.length; i++) {
    const s = span * parts[i];
    const r1 = i === parts.length - 1 ? 0.1 : r * 0.62;
    if (y <= y0 + s) return r + ((r1 - r) * (y - y0)) / s;
    y0 += s;
    r = r1 * 0.85;
  }
  return 0.1;
}

/** Heights of makeSpire's two collars, where the stays meet the mast. */
function collars(): number[] {
  const footing = Math.min(1.8, SPIRE.height * 0.1);
  const span = SPIRE.height - 0.5 - 0.42 - footing;
  return [footing + span * 0.42, footing + span * 0.75];
}

/** The three galleries' heights. */
const GALLERIES = [0.34, 0.58, 0.8];

/** A rod of radius r from a to b. */
function rod(k: Kit, mat: MatKey, a: THREE.Vector3, b: THREE.Vector3, r: number, sides = 5): void {
  const dir = b.clone().sub(a);
  const len = dir.length();
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
  k.add(mat, new THREE.CylinderGeometry(r, r, len, sides, 1, true), new THREE.Matrix4().compose(a.clone().add(b).multiplyScalar(0.5), q, new THREE.Vector3(1, 1, 1)));
}

/** Where the tip lamp's centre stands on the unscaled mast. */
const TIP_Y = SPIRE.height - 0.5 - 0.21;

/**
 * Every lamp on the mast, unscaled: where it stands and its radius. The tip
 * lamp and the mid lamp where makeSpire hangs them, and eight small lenses
 * round each gallery's rim. Each is drawn as its own round instance, so a
 * mast drawn in on a narrow roof never stretches a lamp into an egg.
 */
function lampSpots(): Array<{ at: THREE.Vector3; r: number }> {
  const footing = Math.min(1.8, SPIRE.height * 0.1);
  const span = SPIRE.height - 0.5 - 0.42 - footing;
  const r1 = 2.2 * 0.5 * 0.62;
  const out = [
    { at: new THREE.Vector3(0, TIP_Y, 0), r: 0.21 },
    { at: new THREE.Vector3(0, footing + span * 0.42 - 0.3, r1 + 0.4), r: 0.13 },
  ];
  for (const g of GALLERIES) {
    const y = g * SPIRE.height;
    const r = mastAt(y) + 0.42;
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
      out.push({ at: new THREE.Vector3(Math.cos(a) * r, y + 0.1, Math.sin(a) * r), r: 0.075 });
    }
  }
  return out;
}
const LAMPS = lampSpots();

/** The steel: the needle's mast, the galleries, the stays and their anchor plates. */
function mastKit(k: Kit): void {
  // In galvanised steel throughout, its joint collars included: the needle's dark collars read as black bands on a lit mast.
  k.remap = { beacon: null, steel: 'galvanised' };
  makeSpire(k, SPIRE.height, 8);
  k.remap = {};
  for (const g of GALLERIES) {
    const y = g * SPIRE.height;
    const r = mastAt(y);
    // A grated platform on four brackets, a handrail round it.
    k.add('steel', lathe([[r, -0.05], [r + 0.48, -0.05], [r + 0.48, 0.03], [r, 0.03]], 16), M(0, y, 0));
    k.add('galvanised', lathe([[r + 0.44, 0.5], [r + 0.48, 0.5], [r + 0.48, 0.55], [r + 0.44, 0.55]], 16), M(0, y, 0));
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2;
      const c = Math.cos(a);
      const s = Math.sin(a);
      rod(k, 'steel', new THREE.Vector3(c * r, y - 0.45, s * r), new THREE.Vector3(c * (r + 0.46), y - 0.04, s * (r + 0.46)), 0.03, 4);
      rod(k, 'galvanised', new THREE.Vector3(c * (r + 0.46), y, s * (r + 0.46)), new THREE.Vector3(c * (r + 0.46), y + 0.52, s * (r + 0.46)), 0.02, 4);
    }
  }
}

/**
 * Two levels of stays to four anchor plates on the roof's diagonals. Drawn
 * apart from the mast: on a narrow roof they draw in (their plates stay on
 * it) while the mast, its lamps and its finial keep their true proportions.
 * Each stay ends inside the mast, so drawing in never parts it from the steel.
 */
function stayKit(k: Kit): void {
  for (let i = 0; i < 4; i++) {
    const a = Math.PI / 4 + (i / 4) * Math.PI * 2;
    const foot = new THREE.Vector3(Math.cos(a) * SPIRE.anchor, 0.22, Math.sin(a) * SPIRE.anchor);
    k.box('steel', 0.5, 0.18, 0.5, M(foot.x, 0.09, foot.z, -a));
    k.box('steel', 0.08, 0.28, 0.26, M(foot.x, 0.28, foot.z, -a));
    for (const y of collars()) {
      rod(k, 'galvanised', foot, new THREE.Vector3(Math.cos(a) * 0.12, y - 0.12, Math.sin(a) * 0.12), 0.024);
    }
  }
}

/** One lamp: a unit lens, scaled to each spot. */
function lampKit(k: Kit): void {
  k.add('beacon', new THREE.SphereGeometry(1, 12, 8));
}

/** The founding skyline's finial: a bronze collar, bell and orb over the tip lamp, drawn to a point; its origin the tip lamp's centre. */
function finialKit(k: Kit): void {
  const top = -0.21;
  k.add('datum', lathe([[0, -0.32], [0.17, -0.32], [0.17, -0.2], [0.26, -0.08], [0.27, 0.02], [0.12, 0.12], [0.08, 0.3], [0, 0.3]], 20), M(0, top, 0));
  k.add('datum', new THREE.SphereGeometry(0.3, 20, 12), M(0, top + 0.56, 0));
  k.add('datum', lathe([[0, 0], [0.09, 0], [0.06, 0.2], [0.035, 0.7], [0, 1.25]], 12), M(0, top + 0.8, 0));
}

/** The founding skyline's sleeve: a bronze band round the mast's battered footing. */
function sleeveKit(k: Kit): void {
  const footing = Math.min(1.8, SPIRE.height * 0.1);
  const base = 2.2;
  k.add('datum', lathe([[base * 1.04, 0], [base * 1.07, 0.02], [base * 1.07, footing * 0.3], [base * 1.0, footing * 0.36], [base * 0.97, footing * 0.33]], 8), M(0, 0, 0, Math.PI / 8));
}

/** One part, built once: its merged geometry per material from a Kit. */
function parts(m: TowerMaterials, quality: 'high' | 'medium', build: (k: Kit) => void): Array<{ geo: THREE.BufferGeometry; mat: THREE.Material; key: string }> {
  const k = new Kit(m);
  k.detail = quality === 'high';
  build(k);
  const g = k.build();
  const out: Array<{ geo: THREE.BufferGeometry; mat: THREE.Material; key: string }> = [];
  g.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh && !(o as THREE.InstancedMesh).isInstancedMesh) out.push({ geo: mesh.geometry, mat: mesh.material as THREE.Material, key: mesh.name.replace(/^tower:/, '') });
  });
  return out;
}

const DAY = 86_400_000;
const weekday = new Intl.DateTimeFormat('en-US', { weekday: 'long' });
const shortDate = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });

/**
 * What a floor's row in the inspector says of its milestone, quietly:
 * "the skyline, since Tuesday" (or since today, or a date past a week);
 * a passed holder "held the skyline".
 */
export function milestoneNote(m: Milestone, now: number = Date.now()): string {
  const what = m.title.replace(/^The /, 'the ');
  if (m.kind === 'skyline' && !m.lit) return `held ${what}`;
  // A ribbon names its firm, and needs no date: "first PR of Quickset".
  if (m.kind === 'ribbon') return m.title.replace(/^The /, '');
  const at = Date.parse(m.at);
  const day = (t: number): number => {
    const d = new Date(t);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  };
  const days = Math.round((day(now) - day(at)) / DAY);
  const since = days <= 0 ? 'today' : days < 7 ? weekday.format(at) : shortDate.format(at);
  return `${what}, since ${since}`;
}

/** The instanced draws, one per part, grown as the city needs more of them. */
class Draw {
  mesh: THREE.InstancedMesh;
  constructor(
    readonly geo: THREE.BufferGeometry,
    readonly mat: THREE.Material,
    readonly name: string,
    readonly shadow: boolean,
    readonly group: THREE.Group,
  ) {
    this.mesh = this.make(4);
  }
  private make(n: number): THREE.InstancedMesh {
    const m = new THREE.InstancedMesh(this.geo, this.mat, n);
    m.name = `milestone:${this.name}`;
    m.castShadow = this.shadow;
    m.receiveShadow = true;
    m.count = 0;
    m.visible = false;
    m.frustumCulled = true;
    if (!this.shadow) setLayers(m, 0, LAYER.view);
    this.group.add(m);
    return m;
  }
  set(ms: THREE.Matrix4[]): void {
    if (ms.length > this.mesh.instanceMatrix.count) {
      this.group.remove(this.mesh);
      this.mesh.dispose();
      this.mesh = this.make(Math.max(ms.length, this.mesh.instanceMatrix.count * 2));
    }
    ms.forEach((m, i) => this.mesh.setMatrixAt(i, m));
    this.mesh.count = ms.length;
    this.mesh.visible = ms.length > 0;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (ms.length) {
      this.mesh.computeBoundingBox();
      this.mesh.computeBoundingSphere();
    }
  }
  dispose(): void {
    this.mesh.dispose();
    this.geo.dispose();
  }
}

export function createMilestones(opts: { quality: 'high' | 'medium'; materials: TowerMaterials; firmColour?: (firmId: string) => THREE.Color }): Milestones {
  const group = new THREE.Group();
  group.name = 'milestones';
  const [lr, lg, lb] = SPIRE.lamp;
  const lamp = new THREE.MeshBasicMaterial({ color: new THREE.Color(lr, lg, lb) });
  lamp.name = 'milestone-lamp';
  // A lamp with the power off: a dark amber lens, a little gloss, so it still reads as glass up close.
  const darkLamp = new THREE.MeshStandardMaterial({ color: 0x3a2516, roughness: 0.28, metalness: 0.1 });
  darkLamp.name = 'milestone-lamp-dark';
  const m = opts.materials;

  const mast = parts(m, opts.quality, mastKit).map((p) => new Draw(p.geo, p.mat, `mast:${p.key}`, true, group));
  const stays = parts(m, opts.quality, stayKit).map((p) => new Draw(p.geo, p.mat, `stays:${p.key}`, true, group));
  const lampGeo = parts(m, opts.quality, lampKit)[0].geo;
  const litLamps = new Draw(lampGeo, lamp, 'lamp:lit', false, group);
  const darkLamps = new Draw(lampGeo.clone(), darkLamp, 'lamp:dark', false, group);
  const finials = parts(m, opts.quality, finialKit).map((p) => new Draw(p.geo, p.mat, 'finial', true, group));
  const sleeves = parts(m, opts.quality, sleeveKit).map((p) => new Draw(p.geo, p.mat, 'sleeve', true, group));

  // The far point: the lit tip as a two pixel lamp at any distance, depth tested, never bloomed.
  const pointGeo = new THREE.BufferGeometry();
  pointGeo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(3 * 8), 3));
  const pointMat = new THREE.PointsMaterial({ color: lamp.color.clone(), size: SPIRE.point, sizeAttenuation: false, fog: false });
  const points = new THREE.Points(pointGeo, pointMat);
  points.name = 'milestone:tip';
  points.frustumCulled = false;
  setLayers(points, LAYER.view);
  group.add(points);

  // The revivals' scaffolds, by milestone id, kept while what they stand on is unchanged; every bulb in one emitter.
  const revivals = new Map<string, { key: string; s: LitScaffold }>();
  const [br, bg, bb] = FESTOON.bulb;
  const bulb = new THREE.MeshBasicMaterial({ color: new THREE.Color(br, bg, bb) });
  bulb.name = 'milestone-festoon';
  const bulbGeo = new THREE.SphereGeometry(FESTOON.radius, 8, 6);
  let festoon = makeFestoon(64);
  function makeFestoon(n: number): THREE.InstancedMesh {
    const m = new THREE.InstancedMesh(bulbGeo, bulb, n);
    m.name = 'milestone:festoon';
    m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 3).fill(1), 3);
    m.count = 0;
    m.visible = false;
    m.castShadow = false;
    setLayers(m, 0, LAYER.view);
    group.add(m);
    return m;
  }
  let bulbs = 0;
  let bulbHash = new Float32Array(0);

  let shows = new Map<string, MilestoneShow>();
  const ribbonMat = ribbonMaterial();
  const ribbonMesh = new THREE.Mesh(new THREE.BufferGeometry(), ribbonMat);
  ribbonMesh.name = 'milestone:ribbon';
  ribbonMesh.castShadow = true;
  ribbonMesh.receiveShadow = true;
  ribbonMesh.visible = false;
  group.add(ribbonMesh);
  let lastRibbons = '';
  let lastClock = 0;
  /** Each bulb's level now: its own, wavering a little on two slow beats; a dead one barely glows. */
  function flicker(clock: number): void {
    lastClock = clock;
    if (!bulbs) return;
    const c = festoon.instanceColor!;
    for (let i = 0; i < bulbs; i++) {
      const h = bulbHash[i * 2];
      const h2 = bulbHash[i * 2 + 1];
      const k = h2 < FESTOON.dead ? 0.08 : 0.72 + 0.2 * h + 0.05 * Math.sin(clock * (1.3 + 2.1 * h) + h2 * 40) + 0.03 * Math.sin(clock * (7 + 5 * h2) + h * 17);
      c.setXYZ(i, k, k, k);
    }
    c.needsUpdate = true;
  }

  return {
    group,
    lamp,
    point: pointMat,
    set(ms, towers, now = Date.now(), o = {}) {
      const byTower = new Map<string, { sky?: Milestone; founding?: Milestone }>();
      let next: number | null = null;
      const revived: Milestone[] = [];
      const ribbons: Milestone[] = [];
      for (const r of ms) {
        if (r.kind === 'ribbon') {
          // A bankrupt firm's ribbon comes down the frame its towers darken, before the engine's patch arrives.
          if (r.firmId && o.fallen?.has(r.firmId)) continue;
          const until = r.until === null ? null : Date.parse(r.until);
          if (until !== null && until <= now) continue;
          if (until !== null && (next === null || until < next)) next = until;
          ribbons.push(r);
          continue;
        }
        if (r.kind !== 'skyline' && r.kind !== 'founding-skyline' && r.kind !== 'revival') continue;
        const until = r.until === null ? null : Date.parse(r.until);
        if (until !== null && until <= now) continue;
        if (until !== null && (next === null || until < next)) next = until;
        if (r.kind === 'revival') {
          revived.push(r);
          continue;
        }
        const e = byTower.get(r.towerId) ?? {};
        if (r.kind === 'skyline') e.sky = r;
        else e.founding = r;
        byTower.set(r.towerId, e);
      }
      const nextShows = new Map<string, MilestoneShow>();
      const at = { stays: [] as THREE.Matrix4[], mast: [] as THREE.Matrix4[], lit: [] as THREE.Matrix4[], dark: [] as THREE.Matrix4[], finial: [] as THREE.Matrix4[], sleeve: [] as THREE.Matrix4[] };
      const tips: THREE.Vector3[] = [];
      for (const [towerId, e] of byTower) {
        const piece = towers(towerId);
        if (!piece) continue;
        const foot = piece.roof();
        const height = spireHeight(piece.layout.top);
        const s = height / SPIRE.height;
        // On a narrow roof the stays draw in, so their plates stay on it.
        const sxz = Math.min(s, (piece.half * 0.88) / SPIRE.anchor);
        const matrix = new THREE.Matrix4().compose(foot, new THREE.Quaternion(), new THREE.Vector3(sxz, s, sxz));
        const lit = e.sky?.lit === true;
        at.mast.push(matrix);
        at.stays.push(matrix);
        // Each lamp round, at its spot on the mast as drawn: the lenses take the mast's girth, never its height.
        const where = (p: THREE.Vector3): THREE.Vector3 => new THREE.Vector3(foot.x + p.x * sxz, foot.y + p.y * s, foot.z + p.z * sxz);
        for (const l of LAMPS) {
          const r = l.r * Math.max(sxz, 0.75);
          (lit ? at.lit : at.dark).push(new THREE.Matrix4().compose(where(l.at), new THREE.Quaternion(), new THREE.Vector3(r, r, r)));
        }
        const tip = where(LAMPS[0].at);
        if (e.founding) {
          at.sleeve.push(matrix);
          if (!lit) at.finial.push(new THREE.Matrix4().compose(tip, new THREE.Quaternion(), new THREE.Vector3(sxz, sxz, sxz)));
        }
        if (lit) tips.push(tip);
        const tipTop = foot.clone().add(new THREE.Vector3(0, height, 0));
        for (const r of [e.sky, e.founding]) {
          if (r) nextShows.set(r.id, { kind: r.kind, towerId, lit: r.kind === 'skyline' && r.lit, y: foot.y, height, tip: (lit ? tip : tipTop).toArray() });
        }
      }
      for (const d of mast) d.set(at.mast);
      for (const d of stays) d.set(at.stays);
      litLamps.set(at.lit);
      darkLamps.set(at.dark);
      for (const d of finials) d.set(at.finial);
      for (const d of sleeves) d.set(at.sleeve);
      let pos = pointGeo.attributes.position as THREE.BufferAttribute;
      if (tips.length > pos.count) {
        pointGeo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(3 * tips.length * 2), 3));
        pos = pointGeo.attributes.position as THREE.BufferAttribute;
      }
      tips.forEach((t, i) => pos.setXYZ(i, t.x, t.y, t.z));
      pos.needsUpdate = true;
      pointGeo.setDrawRange(0, tips.length);
      points.visible = tips.length > 0;
      // The revivals: a scaffold round the revived floor and the one below, a festoon to each.
      const wanted = new Set<string>();
      const lampsAt: THREE.Vector3[] = [];
      for (const r of revived) {
        const piece = r.floorId ? towers(r.towerId) : null;
        const f = piece && r.floorId ? piece.floor(r.floorId) : null;
        if (!piece || !f) continue;
        const below = f.index > 0 ? piece.floor(piece.layout.floors[f.index - 1].floor.id) : null;
        const base = below ?? f;
        // A working gap of half a metre off each floor's face.
        const stages = [...(below ? [below] : []), f].map((x) => ({ halfX: x.half + 0.5, halfZ: x.half + 0.5, y0: x.y0 - base.y0, y1: x.y0 + x.h - base.y0 }));
        piece.group.updateWorldMatrix(true, false);
        const foot = piece.group.localToWorld(new THREE.Vector3(f.cx, base.y0, f.cz));
        const turn = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().extractRotation(piece.group.matrixWorld)).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), f.ry));
        const key = JSON.stringify([stages, foot.toArray().map((v) => v.toFixed(3)), turn.toArray().map((v) => v.toFixed(4))]);
        let e = revivals.get(r.id);
        if (e && e.key !== key) {
          group.remove(e.s.object);
          e.s.dispose();
          e = undefined;
        }
        if (!e) {
          // A working deck over the revived floor only when it is the tower's top.
          const s = makeLitScaffold(stages, f.index === piece.layout.floors.length - 1);
          s.object.name = `revival:${r.id}`;
          s.object.position.copy(foot);
          s.object.quaternion.copy(turn);
          group.add(s.object);
          e = { key, s };
          revivals.set(r.id, e);
        }
        wanted.add(r.id);
        e.s.object.updateMatrixWorld(true);
        for (const l of e.s.lamps) lampsAt.push(e.s.object.localToWorld(l.clone()));
        nextShows.set(r.id, { kind: 'revival', towerId: r.towerId, lit: true, y: foot.y, height: e.s.height, tip: foot.clone().add(new THREE.Vector3(0, e.s.height, 0)).toArray() });
      }
      for (const [id, e] of revivals) {
        if (wanted.has(id)) continue;
        group.remove(e.s.object);
        e.s.dispose();
        revivals.delete(id);
      }
      if (lampsAt.length > festoon.instanceMatrix.count) {
        group.remove(festoon);
        festoon.dispose();
        festoon = makeFestoon(lampsAt.length * 2);
      }
      lampsAt.forEach((p, i) => festoon.setMatrixAt(i, new THREE.Matrix4().makeTranslation(p.x, p.y, p.z)));
      festoon.count = lampsAt.length;
      festoon.visible = lampsAt.length > 0;
      festoon.instanceMatrix.needsUpdate = true;
      if (lampsAt.length) festoon.computeBoundingSphere();
      bulbs = lampsAt.length;
      // Each bulb's two hashes, worked out once here rather than every frame.
      if (bulbHash.length < bulbs * 2) bulbHash = new Float32Array(bulbs * 4);
      for (let i = 0; i < bulbs; i++) {
        bulbHash[i * 2] = hash01(i * 7 + 1);
        bulbHash[i * 2 + 1] = hash01(i * 13 + 5);
      }
      flicker(lastClock);

      // The ribbons: one geometry for all of them, sewn again only when what they wrap changes.
      const specs: RibbonSpec[] = [];
      for (const r of ribbons) {
        const piece = r.floorId ? towers(r.towerId) : null;
        const f = piece && r.floorId ? piece.floor(r.floorId) : null;
        if (!piece || !f) continue;
        piece.group.updateWorldMatrix(true, false);
        const centre = piece.group.localToWorld(new THREE.Vector3(f.cx, 0, f.cz));
        const turn = new THREE.Euler().setFromRotationMatrix(new THREE.Matrix4().extractRotation(piece.group.matrixWorld), 'YXZ').y + f.ry;
        // Across the floor's face a little above its middle, clear of the slab edge and its line, so it reads as cloth, not trim.
        const y = piece.group.localToWorld(new THREE.Vector3(0, f.y0 + f.h * 0.62, 0)).y;
        const colour = r.firmId ? (opts.firmColour?.(r.firmId) ?? new THREE.Color(0.55, 0.1, 0.12)) : new THREE.Color(0.55, 0.1, 0.12);
        specs.push({ centre, ry: turn, half: f.half, y, colour });
        nextShows.set(r.id, { kind: 'ribbon', towerId: r.towerId, lit: false, y, height: RIBBON.band, tip: [centre.x, y, centre.z] });
      }
      const ribbonKey = JSON.stringify(specs.map((x) => [x.centre.toArray().map((v) => v.toFixed(3)), x.ry.toFixed(4), x.half.toFixed(3), x.y.toFixed(3), x.colour.getHexString()]));
      if (ribbonKey !== lastRibbons) {
        lastRibbons = ribbonKey;
        ribbonMesh.geometry.dispose();
        ribbonMesh.geometry = ribbonGeometry(specs);
        ribbonMat.sheenColor.copy(sheenOf(specs.map((x) => x.colour)));
      }
      ribbonMesh.visible = specs.length > 0;

      shows = nextShows;
      return next;
    },
    update(_dt, clock) {
      flicker(clock);
      ribbonMat.userData.time.value = clock;
      const t = 0.5 - 0.5 * Math.cos((clock / SPIRE.period) * Math.PI * 2);
      const k = SPIRE.breath[0] + (SPIRE.breath[1] - SPIRE.breath[0]) * t;
      lamp.color.setRGB(lr * k, lg * k, lb * k);
      // The far point holds the lamp's light without its low: from across the city a breath to near nothing would read as a fault.
      const kp = Math.max(k, 0.8);
      pointMat.color.setRGB(lr * kp, lg * kp, lb * kp);
    },
    shows: () => new Map(shows),
    dispose() {
      ribbonMesh.geometry.dispose();
      ribbonMat.dispose();
      for (const e of revivals.values()) e.s.dispose();
      revivals.clear();
      festoon.dispose();
      bulbGeo.dispose();
      bulb.dispose();
      for (const d of [...mast, ...stays, litLamps, darkLamps, ...finials, ...sleeves]) d.dispose();
      lamp.dispose();
      darkLamp.dispose();
      pointGeo.dispose();
      pointMat.dispose();
      group.removeFromParent();
    },
  };
}
