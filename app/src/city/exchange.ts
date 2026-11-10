/**
 * The civic exchange (spec 6.1): the job board as a place in the city. A
 * Beaux-Arts exchange hall on the civic plaza at the origin, facing the
 * home framing (+z): a stepped granite stylobate and a grand stair, a
 * recessed portico of eight fluted Corinthian columns between two
 * rusticated end pavilions, an entablature whose frieze carries the tote
 * board, an attic with a clock over the entrance, and a shallow copper dome
 * on a drum of lit clerestory windows, crowned by a glazed lantern.
 *
 * The tote board is honest: one brass slot per open or bidding job (up to
 * EXCHANGE_SLOTS, in the order they were posted), lit while the job takes
 * bids, with a small lamp lit for every bid it has received (real counts,
 * never more than the slot carries), and dark where nothing is posted. The
 * forecourt fountain runs only while the engine is not stopped, so the kill
 * switch shows in the city as still water. The four lamp standards light the
 * forecourt; the ground paints their pools (ground.ts).
 *
 * Modelled in code (own work), with the tower kit's parts: fluted shafts,
 * turned bases and capitals, swept mouldings. Repeated parts are instanced.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

import type { JobStatus } from '../../../shared/types.js';
import { flutedShaft, Kit, lathe, M, ME, type MatKey, paneData, PANE_SASH, PANE_SILL, piercedWall, roundArch, type TowerMaterials, wedge } from './tower/kit.js';

/** The route the hall opens when picked: the job board screen (Task 36). */
export const JOBS_ROUTE = '#/jobs';
/** Slots on the tote board. */
export const EXCHANGE_SLOTS = 24;
/** Bid lamps under each slot. */
export const LAMPS_PER_SLOT = 6;

/**
 * The hall as drawn: `width` across (x), `depth` from the back wall at `z0`
 * to the column line's front, and the grand stair's run (landing included)
 * in front of it. The hall is modelled at these numbers and stood in the
 * city at HALL_SCALE, moved HALL_SHIFT toward the forecourt.
 */
const D = { width: 68, depth: 44, z0: -40, stair: 8 };
/** The hall stands at this scale: a civic landmark that still reads beside towers four hundred metres tall. */
export const HALL_SCALE = 1.25;
const HALL_SHIFT = 4;
/** The hall's footprint in the city, in metres from the plaza's centre. */
export const HALL = { width: D.width * HALL_SCALE, depth: D.depth * HALL_SCALE, z0: D.z0 * HALL_SCALE + HALL_SHIFT, stair: (D.stair + 1.6) * HALL_SCALE };
/** The forecourt fountain: its centre and the basin's outer radius. */
export const FOUNTAIN = { x: 0, z: 42, radius: 10 };
/** The four lamp standards on the forecourt (the ground lights a pool under each). */
export const CIVIC_LAMPS: ReadonlyArray<{ x: number; z: number }> = [
  { x: -20, z: 26 },
  { x: 20, z: 26 },
  { x: -20, z: 58 },
  { x: 20, z: 58 },
];

/** True within `margin` metres of the hall's footprint, steps and stair included (grid.ts keeps the plaza's lanterns off it). */
export function onExchange(x: number, z: number, margin: number): boolean {
  const steps = 1.6 * HALL_SCALE;
  return Math.abs(x) < HALL.width / 2 + steps + margin && z > HALL.z0 - steps - margin && z < HALL.z0 + HALL.depth + HALL.stair + margin;
}

/** What one slot shows: a job taking bids (lit, with its bids' lamps), a job posted and not yet open for bids (dark), or nothing. */
export interface BoardSlot {
  state: 'bidding' | 'open' | 'empty';
  lamps: number;
  label?: string;
}

/** A job as the board reads it. */
export interface BoardJob {
  status: JobStatus;
  bids: number;
  /** The card's words (boardLabel), already safe to show. */
  label?: string;
}

/**
 * The board for a set of jobs: the open and bidding ones in the order given,
 * up to EXCHANGE_SLOTS; every other status is ignored. A bidding slot lights
 * one lamp per whole bid, up to LAMPS_PER_SLOT; an open slot stays dark.
 */
export function toteBoard(jobs: ReadonlyArray<BoardJob>): BoardSlot[] {
  const posted = jobs.filter((j) => j.status === 'open' || j.status === 'bidding').slice(0, EXCHANGE_SLOTS);
  return Array.from({ length: EXCHANGE_SLOTS }, (_, i): BoardSlot => {
    const j = posted[i];
    if (!j) return { state: 'empty', lamps: 0 };
    const lamps = j.status === 'bidding' ? Math.max(0, Math.min(LAMPS_PER_SLOT, Math.floor(Number.isFinite(j.bids) ? j.bids : 0))) : 0;
    return { state: j.status as 'open' | 'bidding', lamps, ...(j.label ? { label: j.label } : {}) };
  });
}

/** A repo name's own characters (GitHub's rule): nothing else reaches a card. */
const NAME = /^[A-Za-z0-9._-]{1,100}$/;
/** Shapes of keys and tokens: a name that looks like one is never shown. */
const SECRET = /^(?:gh[pousr]_|github_pat_|sk-|xox[abposr]-|glpat-|AKIA|ASIA|eyJ)|[A-Za-z0-9+_]{32,}/;
const CARD_CHARS = 15;

/**
 * The words on a slot's card: the repo's short name and the issue number,
 * nothing from the issue's own text. The name passes only if it is a real
 * repo name (owner/name in GitHub's characters) and not shaped like a token;
 * it is cut to fit the card.
 */
export function boardLabel(job: { repo: string; issue: number | null }): string {
  const parts = job.repo.split('/');
  const name = parts.length === 2 && NAME.test(parts[0]) && NAME.test(parts[1]) && !SECRET.test(parts[1]) ? parts[1] : '';
  const short = name.length > CARD_CHARS ? `${name.slice(0, CARD_CHARS - 1)}.` : name;
  const issue = Number.isInteger(job.issue) && (job.issue as number) > 0 && (job.issue as number) < 1e6 ? `#${job.issue}` : '';
  return [short, issue].filter(Boolean).join(' ');
}

export interface Exchange {
  object: THREE.Object3D;
  /** The hall's pick proxies, each mapped to the route it opens. */
  pickables: Map<THREE.Object3D, string>;
  setBoard(jobs: ReadonlyArray<BoardJob>): void;
  setStopped(stopped: boolean): void;
  /** The board as it shows now. */
  slots(): BoardSlot[];
  /** True while the engine runs: the fountain's water is rising (or rising again). */
  fountainRunning(): boolean;
  /** Advances the water, a new bid's lamp coming up, and the clock. Call once a frame. */
  update(dt: number): void;
  dispose(): void;
}

export interface ExchangeOptions {
  /** The city's stone and glass (look.ts towerMaterials); plain stand-ins in node tests. */
  materials?: TowerMaterials;
}

// ---------------------------------------------------------------- dimensions

/** Podium top: the floor of the portico and the hall. */
const PODIUM = 3.0;
/** The giant order, base to abacus. */
const ORDER = 15.75;
const ENT0 = PODIUM + ORDER;
/** Entablature: architrave, frieze (the tote board), cornice. */
const FRIEZE0 = ENT0 + 1.3;
const FRIEZE1 = ENT0 + 3.0;
const ENT1 = ENT0 + 3.95;
const ATTIC = ENT1 + 4.9;
/** The front of the column line and the entablature over it. */
const FRONT = D.z0 + D.depth;
const HALF_W = D.width / 2;
const HALF_D = D.depth / 2;
const CZ = D.z0 + HALF_D;
/** The portico between the pavilions, and its inner wall. */
const PORTICO_HALF = 22.6;
const INNER = -3;
const COLS = 8;
const COL_PITCH = 5.5;
const COL_Z = FRONT - 0.85;
const COL_R = 0.95;
/** The dome: its centre on the plan, the drum, and the shallow copper cap. */
const DOME_Z = -19;
const DRUM_R = 12.5;
const DRUM0 = ATTIC + 1.2;
const DRUM1 = DRUM0 + 6.2;
const DOME0 = DRUM1 + 0.9;
const DOME_RISE = 9;
const DOME_R = DRUM_R + 0.4;
/** The tote board's run along the frieze. */
const SLOT_PITCH = 1.75;
const BOARD_Y = (FRIEZE0 + FRIEZE1) / 2;

/** Extra materials the exchange owns, on top of the city's stone and glass. */
type Own = 'copper' | 'seam' | 'brass' | 'enamel' | 'iron' | 'glow' | 'globe' | 'skylight';
const X = (k: Own | MatKey): MatKey => k as MatKey;

/** The tower materials the exchange is built from, by key. */
const USED: MatKey[] = ['limestone', 'granite', 'steel', 'slab', 'roof', 'window', 'datum', 'vent', 'pick', 'darkGlass'];

function plainMaterials(): TowerMaterials {
  const out: Partial<Record<MatKey, THREE.Material>> = {};
  for (const k of USED) out[k] = new THREE.MeshStandardMaterial({ name: k });
  return out as TowerMaterials;
}

// ---------------------------------------------------------------- materials

/**
 * Weathered copper: a patina mottled by the weather and streaked where rain
 * runs down from the ribs, the bare metal browning low on each panel.
 */
function copperMaterial(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color: 0x6b9a88, metalness: 0.25, roughness: 0.62, envMapIntensity: 1.1 });
  m.customProgramCacheKey = () => 'palimpsest-exchange-copper';
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vCuP;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\n{ mat4 fm = modelMatrix;\n#ifdef USE_INSTANCING\nfm = modelMatrix * instanceMatrix;\n#endif\nvCuP = (fm * vec4(transformed, 1.0)).xyz; }');
    sh.fragmentShader = sh.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vCuP;
        float cuH(vec2 p){ p = fract(p*vec2(123.34, 456.21)); p += dot(p, p+45.32); return fract(p.x*p.y); }
        float cuN(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
          return mix(mix(cuH(i), cuH(i+vec2(1,0)), f.x), mix(cuH(i+vec2(0,1)), cuH(i+vec2(1,1)), f.x), f.y); }`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        {
          float a = atan(vCuP.z - ${DOME_Z.toFixed(1)}, vCuP.x);
          float mott = cuN(vCuP.xz * 0.35) * 0.6 + cuN(vCuP.xz * 1.7 + vCuP.y) * 0.4;
          // Rain streaks: fine vertical runs, so the patina reads as weathered metal and not as paint.
          float streak = cuN(vec2(a * 40.0, vCuP.y * 0.25));
          vec3 pale = vec3(0.52, 0.74, 0.66);
          vec3 deep = vec3(0.25, 0.43, 0.38);
          vec3 bare = vec3(0.42, 0.27, 0.17);
          vec3 c = mix(deep, pale, smoothstep(0.25, 0.8, mott * 0.7 + streak * 0.5));
          c = mix(c, bare, smoothstep(0.62, 0.9, cuN(vCuP.xz * 0.9 + 7.0)) * 0.45);
          diffuseColor.rgb *= c / vec3(0.42, 0.6, 0.53);
        }`,
      );
  };
  return m;
}

/**
 * A lamp or a card on the tote board: a dark glass face whose instance
 * colour, when any channel is past 1, is its own light (a lit card, a lit
 * bid lamp); below that the colour is the face's albedo (dark glass, a
 * brass shutter).
 */
function boardMaterial(name: string, roughness: number): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness, metalness: 0.0, envMapIntensity: 1.0, name });
  m.customProgramCacheKey = () => 'palimpsest-exchange-board';
  m.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader.replace(
      '#include <emissivemap_fragment>',
      `#include <emissivemap_fragment>
      #ifdef USE_INSTANCING_COLOR
      {
        float lit = step(1.0, max(vColor.r, max(vColor.g, vColor.b)));
        totalEmissiveRadiance += vColor.rgb * lit;
        diffuseColor.rgb *= 1.0 - lit * 0.97;
      }
      #endif`,
    );
  };
  return m;
}

/**
 * Moving water: pale, half clear, with streaks running down the sheets and
 * up the jet (uv v runs along each piece's flow), fading out as the flow stops.
 */
function waterMaterial(uniforms: { uTime: { value: number }; uFlow: { value: number } }): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({
    color: 0xdcebef,
    roughness: 0.08,
    metalness: 0,
    transparent: true,
    opacity: 0.36,
    depthWrite: false,
    side: THREE.DoubleSide,
    envMapIntensity: 1.6,
    emissive: new THREE.Color(0.05, 0.06, 0.065),
  });
  m.customProgramCacheKey = () => 'palimpsest-exchange-water';
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vWUv;')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\nvWUv = uv;');
    sh.fragmentShader = sh.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec2 vWUv;
        uniform float uTime;
        uniform float uFlow;
        float wH(vec2 p){ p = fract(p*vec2(123.34, 456.21)); p += dot(p, p+45.32); return fract(p.x*p.y); }`,
      )
      .replace(
        '#include <alphamap_fragment>',
        `#include <alphamap_fragment>
        {
          // Fine falling threads, too many to read one by one: the sheet shimmers rather than tiles.
          float lane = floor(vWUv.x * 240.0);
          float s = fract(vWUv.y * 2.5 - uTime * (1.4 + 0.8 * wH(vec2(lane, 1.0))) + wH(vec2(lane, 7.0)));
          float streak = 0.35 + 0.65 * smoothstep(0.0, 0.35, s) * (1.0 - smoothstep(0.35, 1.0, s));
          diffuseColor.a *= streak * uFlow;
        }`,
      );
  };
  return m;
}

/** Still or rippling dark water in the basin and the bowls: rings run out from the jet while the fountain runs. */
function poolMaterial(uniforms: { uTime: { value: number }; uFlow: { value: number } }): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color: 0x0b1513, roughness: 0.07, metalness: 0.0, envMapIntensity: 0.95 });
  m.customProgramCacheKey = () => 'palimpsest-exchange-pool';
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vPoP;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvPoP = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vPoP;\nuniform float uTime;\nuniform float uFlow;')
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
        {
          vec2 d = vPoP.xz - vec2(${FOUNTAIN.x.toFixed(1)}, ${FOUNTAIN.z.toFixed(1)});
          float r = max(length(d), 0.001);
          float amp = uFlow * 0.09 * (0.3 + 0.7 * exp(-r * 0.15));
          float ang = atan(d.y, d.x);
          float w = cos(r * 6.5 - uTime * 4.2 + 1.7 * sin(ang * 5.0 + r * 0.7)) + 0.6 * cos(r * 13.0 - uTime * 7.3 + 2.3 * sin(ang * 9.0 - r));
          vec2 g = d / r * w * amp;
          normal = normalize(normal + (viewMatrix * vec4(g.x, 0.0, g.y, 0.0)).xyz);
        }`,
      );
  };
  return m;
}

// ---------------------------------------------------------------- shapes

/**
 * A moulding swept round a rectangle of half-sides `hw` (x) and `hd` (z)
 * centred at (0, cz): `profile` pairs are [outward offset, height]. Corners mitre.
 */
function rectSweep(hw: number, hd: number, cz: number, profile: Array<[number, number]>): THREE.BufferGeometry {
  const pos: number[] = [];
  for (let s = 0; s < 4; s++) {
    const r = (s * Math.PI) / 2;
    const c = Math.cos(r);
    const sn = Math.sin(r);
    const along = s % 2 === 0 ? hw : hd;
    const out = s % 2 === 0 ? hd : hw;
    const P = (u: number, y: number, z: number): number[] => [u * c + z * sn, y, -u * sn + z * c + cz];
    for (let j = 0; j < profile.length - 1; j++) {
      const [d0, y0] = profile[j];
      const [d1, y1] = profile[j + 1];
      const a = P(-(along + d0), y0, out + d0);
      const b = P(along + d0, y0, out + d0);
      const cc = P(along + d1, y1, out + d1);
      const d = P(-(along + d1), y1, out + d1);
      pos.push(...a, ...b, ...cc, ...a, ...cc, ...d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

/** The dome's section: a segmental cap, base radius DOME_R, rising DOME_RISE, cut at the lantern's ring. */
function domeProfile(n: number): Array<[number, number]> {
  const R = (DOME_R * DOME_R + DOME_RISE * DOME_RISE) / (2 * DOME_RISE);
  const pts: Array<[number, number]> = [];
  for (let i = 0; i <= n; i++) {
    const r = DOME_R - ((DOME_R - 2.5) * i) / n;
    pts.push([r, Math.sqrt(R * R - r * r) - (R - DOME_RISE)]);
  }
  return pts;
}

/**
 * A standing seam rib following the dome's section in the x-y plane (x
 * outward): `w` wide across, standing `d` proud of the copper.
 */
function ribGeometry(profile: Array<[number, number]>, w: number, d: number): THREE.BufferGeometry {
  const pos: number[] = [];
  const pts = profile.map(([r, y], i) => {
    const [r0, y0] = profile[Math.max(0, i - 1)];
    const [r1, y1] = profile[Math.min(profile.length - 1, i + 1)];
    // The outward normal of the section at this point.
    const tx = r1 - r0;
    const ty = y1 - y0;
    const l = Math.hypot(tx, ty) || 1;
    return { r, y, nx: ty / l, ny: -tx / l };
  });
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const v = (p: typeof a, out: number, side: number): number[] => [p.r + p.nx * out, p.y + p.ny * out, side * w * 0.5];
    const quad = (p: number[], q: number[], r: number[], s: number[]): void => void pos.push(...p, ...q, ...r, ...p, ...r, ...s);
    // Top, then the two sides.
    quad(v(a, d, -1), v(b, d, -1), v(b, d, 1), v(a, d, 1));
    quad(v(a, 0, 1), v(a, d, 1), v(b, d, 1), v(b, 0, 1));
    quad(v(a, 0, -1), v(b, 0, -1), v(b, d, -1), v(a, d, -1));
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

/** A thin tube along points (a jet's arc). */
function tube(points: THREE.Vector3[], r0: number, r1: number): THREE.BufferGeometry {
  const curve = new THREE.CatmullRomCurve3(points);
  const g = new THREE.TubeGeometry(curve, 24, 1, 6, false);
  // Taper from r0 at the nozzle to r1 where it lands.
  const p = g.attributes.position as THREE.BufferAttribute;
  const uv = g.attributes.uv as THREE.BufferAttribute;
  const c = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    const t = uv.getX(i);
    curve.getPointAt(t, c);
    const k = r0 + (r1 - r0) * t;
    p.setXYZ(i, c.x + (p.getX(i) - c.x) * k, c.y + (p.getY(i) - c.y) * k, c.z + (p.getZ(i) - c.z) * k);
    // Flow runs along the tube: v from the nozzle.
    uv.setXY(i, uv.getY(i), t * 3);
  }
  g.computeVertexNormals();
  return g;
}

// ---------------------------------------------------------------- the hall

function stylobate(k: Kit): void {
  const G = X('granite');
  const L = X('limestone');
  // Three granite steps all round, then the podium wall with its base and cap mouldings.
  const steps = [1.6, 1.1, 0.6];
  steps.forEach((o, i) => k.add(G, rectSweep(HALF_W + o, HALF_D + o, CZ, [[-o - 1, i * 0.4], [0, i * 0.4], [0, (i + 1) * 0.4], [-o - 1, (i + 1) * 0.4]])));
  k.add(G, rectSweep(HALF_W, HALF_D, CZ, [[-2, 1.2], [0.25, 1.2], [0.25, 1.5], [0.1, 1.62], [0.1, 1.7], [-2, 1.7]]));
  k.add(L, rectSweep(HALF_W, HALF_D, CZ, [[-2, 1.7], [0.0, 1.7], [0.0, PODIUM - 0.35], [0.18, PODIUM - 0.25], [0.24, PODIUM], [-2, PODIUM]]));
  // The podium carried forward under the columns, to the head of the stair.
  k.box(L, PORTICO_HALF * 2, PODIUM, 1.6, M(0, PODIUM / 2, FRONT + 0.8));
  k.box(L, PORTICO_HALF * 2 + 0.2, 0.25, 1.85, M(0, PODIUM - 0.125, FRONT + 0.85));
  // The podium's floor under the portico, a pale paving.
  k.box(L, PORTICO_HALF * 2, 0.06, FRONT - INNER + 1.2, M(0, PODIUM - 0.02, (FRONT + INNER) / 2 + 0.6));

  // The grand stair across the portico: fifteen granite risers, with stepped cheek blocks either side.
  const risers = 15;
  const rise = PODIUM / risers;
  const tread = D.stair / risers;
  for (let i = 0; i < risers; i++) {
    const y = PODIUM - (i + 1) * rise;
    const z0 = FRONT + 1.6 + i * tread;
    k.box(G, PORTICO_HALF * 2 - 1.2, rise + y, tread + 0.04, M(0, (rise + y) / 2, z0 + tread / 2));
  }
  for (const s of [-1, 1]) {
    const x = s * (PORTICO_HALF - 0.2);
    const len = D.stair + 1.6;
    k.add(L, wedge(1.6, PODIUM + 0.9, len, PODIUM - 0.5), M(x, (PODIUM + 0.9) / 2, FRONT + len / 2));
    // A pedestal at the stair's foot.
    k.box(G, 2.4, 0.4, 2.4, M(x, 0.2, FRONT + len + 0.6));
    k.box(L, 2.0, 1.5, 2.0, M(x, 1.15, FRONT + len + 0.6));
    k.box(L, 2.3, 0.3, 2.3, M(x, 2.05, FRONT + len + 0.6));
  }
}

/** A tall window in a wall's frame: lit glass in a stone architrave, a sill, and a cornice head. */
function window_(k: Kit, F: THREE.Matrix4, u: number, y: number, w: number, h: number, lit: number, head: 'cornice' | 'pediment' | 'none'): void {
  const L = X('limestone');
  k.pane('exchange:pane', 'window', F.clone().multiply(M(u, y + h / 2, 0.06, 0, w, h, 1)), paneData(lit, 0.85, PANE_SASH));
  k.box(L, w + 0.7, 0.32, 0.36, F.clone().multiply(M(u, y - 0.16, 0.18)));
  for (const s of [-1, 1]) k.box(L, 0.32, h + 0.2, 0.26, F.clone().multiply(M(u + s * (w / 2 + 0.16), y + h / 2, 0.13)));
  k.box(L, w + 0.64, 0.3, 0.26, F.clone().multiply(M(u, y + h + 0.15, 0.13)));
  if (head === 'cornice') k.box(L, w + 1.2, 0.26, 0.5, F.clone().multiply(M(u, y + h + 0.5, 0.25)));
  if (head === 'pediment') {
    const span = w + 1.4;
    const a = 0.32;
    for (const s of [-1, 1]) {
      const len = span / 2 / Math.cos(a);
      k.add(L, new THREE.BoxGeometry(len, 0.26, 0.5), F.clone().multiply(ME(u + (s * span) / 4, y + h + 0.45 + Math.tan(a) * (span / 4), 0.25, 0, 0, -s * a)));
    }
    k.box(L, span, 0.2, 0.5, F.clone().multiply(M(u, y + h + 0.4, 0.25)));
  }
}

/** A side or back face of the hall: pilasters of the order, tall lit windows between them, a low window under each. */
function flank(k: Kit, F: THREE.Matrix4, from: number, to: number, bays: number, rand: () => number): void {
  const pitch = (to - from) / bays;
  for (let i = 0; i <= bays; i++) {
    const u = from + i * pitch;
    k.inst('exchange:pilaster', X('limestone'), () => new THREE.BoxGeometry(1.3, ORDER - 1.2, 0.42), F.clone().multiply(M(u, PODIUM + 0.6 + (ORDER - 1.2) / 2, 0.21)));
    k.inst('exchange:pilaster-base', X('limestone'), () => new THREE.BoxGeometry(1.7, 0.6, 0.62), F.clone().multiply(M(u, PODIUM + 0.3, 0.31)));
    k.inst('exchange:pilaster-cap', X('limestone'), () => new THREE.BoxGeometry(1.8, 0.6, 0.66), F.clone().multiply(M(u, ENT0 - 0.3, 0.33)));
  }
  for (let i = 0; i < bays; i++) {
    const u = from + (i + 0.5) * pitch;
    window_(k, F, u, PODIUM + 5.6, Math.min(2.8, pitch - 2.4), 7.6, 0.55 + rand() * 0.4, i % 2 === 0 ? 'pediment' : 'cornice');
    k.pane('exchange:pane-low', 'window', F.clone().multiply(M(u, PODIUM + 2.3, 0.06, 0, Math.min(2.2, pitch - 3), 1.6, 1)), paneData(0.4 + rand() * 0.4, 0.8, PANE_SILL));
  }
}

/** An end pavilion's street face: a rusticated ground storey round an arched window, a pedimented window over it, paired pilasters. */
function pavilion(k: Kit, side: number, rand: () => number): void {
  const L = X('limestone');
  const cx = side * (PORTICO_HALF + HALF_W) / 2;
  const w = HALF_W - PORTICO_HALF;
  const F = M(cx, 0, FRONT);
  // Rustication: proud courses with deep channels between, broken by the arch.
  const top = PODIUM + 6.6;
  const course = 0.66;
  for (let y = PODIUM; y < top - 0.01; y += course) {
    for (const s of [-1, 1]) k.box(L, w / 2 - 2.1, course - 0.09, 0.2, F.clone().multiply(M(s * (w / 4 + 1.05), y + course / 2, 0.1)));
  }
  const arch = roundArch(0, 3.6, 0, 3.6, 16);
  k.add(L, piercedWall(4.2, 6.6, 0.2, [arch]), F.clone().multiply(M(0, PODIUM, 0)));
  k.pane('exchange:pane-arch', 'window', F.clone().multiply(M(0, PODIUM + 2.7, 0.03, 0, 3.6, 5.4, 1)), paneData(0.85, 0.95, PANE_SASH));
  // Voussoirs and a keystone round the arch.
  for (let i = 0; i <= 8; i++) {
    const a = (i / 8) * Math.PI;
    k.box(L, 0.5, 0.95, 0.3, F.clone().multiply(ME(Math.cos(a) * 2.25, PODIUM + 3.6 + Math.sin(a) * 2.25, 0.15, 0, 0, a - Math.PI / 2)));
  }
  k.box(L, 0.8, 1.3, 0.42, F.clone().multiply(M(0, PODIUM + 5.95, 0.21)));
  k.box(L, w + 0.3, 0.55, 0.4, F.clone().multiply(M(0, top + 0.27, 0.2)));
  window_(k, F, 0, top + 1.6, 2.8, 6.0, 0.7 + rand() * 0.25, 'pediment');
  // A balconette under the window.
  k.box(L, 4.4, 0.24, 1.0, F.clone().multiply(M(0, top + 0.95, 0.5)));
  for (let i = 0; i < 9; i++) k.inst('exchange:baluster', L, () => lathe([[0, 0], [0.12, 0], [0.09, 0.1], [0.16, 0.32], [0.08, 0.6], [0.1, 0.66], [0, 0.66]], 10), F.clone().multiply(M(-1.9 + i * 0.475, top + 1.07, 0.85)));
  k.box(L, 4.4, 0.16, 0.36, F.clone().multiply(M(0, top + 1.81, 0.85)));
  // Paired pilasters at each edge of the pavilion.
  for (const e of [-1, 1]) {
    for (const p of [0, 1]) {
      const u = e * (w / 2 - 0.75 - p * 1.7);
      k.inst('exchange:pilaster', L, () => new THREE.BoxGeometry(1.3, ORDER - 1.2, 0.42), F.clone().multiply(M(u, PODIUM + 0.6 + (ORDER - 1.2) / 2, 0.21)));
      k.inst('exchange:pilaster-base', L, () => new THREE.BoxGeometry(1.7, 0.6, 0.62), F.clone().multiply(M(u, PODIUM + 0.3, 0.31)));
      k.inst('exchange:pilaster-cap', L, () => new THREE.BoxGeometry(1.8, 0.6, 0.66), F.clone().multiply(M(u, ENT0 - 0.3, 0.33)));
    }
  }
}

/** The giant order of the portico: Attic bases, fluted shafts, Corinthian bells with two rows of leaves and a moulded abacus. */
function colonnade(k: Kit, detail: boolean): void {
  const L = X('limestone');
  // Plinth, base, shaft, bell and abacus stack to the order's height.
  const shaftH = ORDER - 0.4 - 0.75 - 1.86;
  const base = (): THREE.BufferGeometry =>
    lathe([[0, 0], [1.4, 0], [1.4, 0.24], [1.3, 0.28], [1.32, 0.42], [1.18, 0.5], [1.1, 0.56], [1.15, 0.64], [1.04, 0.72], [0, 0.75]], detail ? 32 : 16);
  const shaft = (): THREE.BufferGeometry => (detail ? flutedShaft(COL_R, shaftH, 24) : new THREE.CylinderGeometry(COL_R * 0.86, COL_R, shaftH, 16).translate(0, shaftH / 2, 0));
  // The bell, flaring to the abacus; the astragal at its foot.
  const bell = (): THREE.BufferGeometry => lathe([[0, 0], [0.93, 0], [0.98, 0.08], [0.9, 0.16], [0.84, 0.2], [0.9, 0.7], [1.02, 1.2], [1.18, 1.5], [0, 1.5]], detail ? 32 : 16);
  const leaf = (): THREE.BufferGeometry => {
    // An acanthus leaf: a curled blade, wide at its middle, its tip turning out.
    const g = new THREE.PlaneGeometry(0.62, 0.8, 4, 6);
    const p = g.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i);
      const y = p.getY(i) + 0.4;
      const t = y / 0.8;
      const width = Math.sin(Math.PI * Math.min(1, t * 1.15)) * (1 - 0.35 * t);
      p.setXYZ(i, x * width, y, 0.06 * Math.cos((x / 0.31) * Math.PI * 0.5) + 0.12 * t * t);
    }
    g.computeVertexNormals();
    return g;
  };
  const abacus = (): THREE.BufferGeometry => {
    // Concave-sided, its corners drawn out.
    const s = new THREE.Shape();
    const h = 1.45;
    const n = 10;
    for (let side = 0; side < 4; side++) {
      for (let i = 0; i < n; i++) {
        const t = i / n;
        const u = -h + 2 * h * t;
        const inset = 0.22 * Math.sin(Math.PI * t);
        const pts = [
          [u, -h + inset],
          [h - inset, u],
          [-u, h - inset],
          [-h + inset, -u],
        ][side];
        if (side === 0 && i === 0) s.moveTo(pts[0], pts[1]);
        else s.lineTo(pts[0], pts[1]);
      }
    }
    s.closePath();
    const g = new THREE.ExtrudeGeometry(s, { depth: 0.36, bevelEnabled: false, curveSegments: 4 });
    g.rotateX(-Math.PI / 2);
    return g;
  };
  for (let i = 0; i < COLS; i++) {
    const x = -((COLS - 1) / 2) * COL_PITCH + i * COL_PITCH;
    const P = M(x, 0, COL_Z);
    k.inst('exchange:plinth', L, () => new THREE.BoxGeometry(2.9, 0.4, 2.9), P.clone().multiply(M(0, PODIUM + 0.2, 0)));
    k.inst('exchange:base', L, base, P.clone().multiply(M(0, PODIUM + 0.4, 0)));
    k.inst('exchange:shaft', L, shaft, P.clone().multiply(M(0, PODIUM + 0.4 + 0.75, 0)));
    const y0 = PODIUM + ORDER - 1.86;
    k.inst('exchange:bell', L, bell, P.clone().multiply(M(0, y0, 0)));
    k.inst('exchange:abacus', L, abacus, P.clone().multiply(M(0, y0 + 1.5, 0)));
    if (detail) {
      for (let j = 0; j < 8; j++) {
        const a = (j / 8) * Math.PI * 2;
        k.inst('exchange:leaf', L, leaf, P.clone().multiply(M(Math.sin(a) * 0.86, y0 + 0.18, Math.cos(a) * 0.86, a)));
        const b = a + Math.PI / 8;
        k.inst('exchange:leaf', L, leaf, P.clone().multiply(M(Math.sin(b) * 0.92, y0 + 0.62, Math.cos(b) * 0.92, b, 1.0, 1.05, 1)));
      }
    }
  }
}

/** The inner wall of the portico: three arched doors standing open on the lit hall, a window over each, niches between. */
function porticoWall(k: Kit, rand: () => number): void {
  const L = X('limestone');
  const doors = [-11, 0, 11];
  const h = ORDER;
  const openings = doors.map((u) => roundArch(u, 4.4, 0.0, 7.4, 16));
  for (const u of doors) openings.push([new THREE.Vector2(u - 1.4, 10.2), new THREE.Vector2(u + 1.4, 10.2), new THREE.Vector2(u + 1.4, 13.6), new THREE.Vector2(u - 1.4, 13.6)]);
  k.add(L, piercedWall(PORTICO_HALF * 2, h, 0.9, openings), M(0, PODIUM, INNER - 0.9));
  for (const u of doors) {
    // The hall beyond: warm light through the doors, and through the window over each.
    k.pane('exchange:pane-door', 'window', M(u, PODIUM + 4.8, INNER - 0.85, 0, 4.4, 9.6, 1), paneData(1, 1, PANE_SASH));
    k.pane('exchange:pane', 'window', M(u, PODIUM + 11.9, INNER - 0.85, 0, 2.8, 3.4, 1), paneData(0.8 + rand() * 0.2, 0.9, PANE_SASH));
    // Door architrave and a cornice over it on consoles.
    k.box(L, 6.0, 0.4, 0.5, M(u, PODIUM + 9.75 + 0.6, INNER + 0.25));
    for (const s of [-1, 1]) k.box(L, 0.35, 0.9, 0.5, M(u + s * 2.8, PODIUM + 9.6, INNER + 0.25));
  }
  // A sunk panel between the doors, with a bronze wall lamp over it.
  for (const u of [-16.6, -5.5, 5.5, 16.6]) {
    k.box(L, 2.2, 5.0, 0.12, M(u, PODIUM + 3.4, INNER + 0.06));
    k.box(L, 2.6, 0.3, 0.4, M(u, PODIUM + 6.05, INNER + 0.2));
    k.box(X('brass'), 0.12, 0.12, 0.6, M(u, PODIUM + 7.0, INNER + 0.3));
    k.box(X('steel'), 0.5, 0.12, 0.5, M(u, PODIUM + 7.86, INNER + 0.6));
    k.box(X('vent'), 0.4, 0.62, 0.4, M(u, PODIUM + 7.48, INNER + 0.6));
    k.box(X('steel'), 0.46, 0.1, 0.46, M(u, PODIUM + 7.12, INNER + 0.6));
  }
  // The coffered ceiling of the portico.
  k.box(X('slab'), PORTICO_HALF * 2, 0.3, FRONT - INNER, M(0, ENT0 - 0.15, (FRONT + INNER) / 2));
  for (let i = 0; i < COLS; i++) {
    const x = -((COLS - 1) / 2) * COL_PITCH + i * COL_PITCH;
    k.inst('exchange:beam', L, () => new THREE.BoxGeometry(1.4, 0.9, 1), M(x, ENT0 - 0.45, (FRONT + INNER) / 2, 0, 1, 1, FRONT - INNER));
  }
  // Lanterns hung in the portico before the doors.
  for (const u of doors) {
    k.box(X('steel'), 0.06, 2.8, 0.06, M(u, ENT0 - 1.6, (FRONT + INNER) / 2 - 0.5));
    k.box(X('steel'), 1.0, 0.18, 1.0, M(u, ENT0 - 3.1, (FRONT + INNER) / 2 - 0.5));
    k.box(X('vent'), 0.8, 1.3, 0.8, M(u, ENT0 - 3.9, (FRONT + INNER) / 2 - 0.5));
    k.box(X('steel'), 0.9, 0.14, 0.9, M(u, ENT0 - 4.6, (FRONT + INNER) / 2 - 0.5));
  }
}

/** Entablature, cornice dentils and the attic, round the whole hall. */
function entablature(k: Kit, detail: boolean): void {
  const L = X('limestone');
  const e = ENT0;
  k.add(
    L,
    rectSweep(HALF_W, HALF_D, CZ, [
      [-2.4, e],
      [0, e],
      [0, e + 0.6],
      [0.1, e + 0.62],
      [0.1, e + 1.2],
      [0.22, e + 1.24],
      [0.22, e + 1.3],
      [0.0, e + 1.3],
      [0.0, e + 3.0],
      [0.25, e + 3.05],
      [0.25, e + 3.25],
      [1.0, e + 3.3],
      [1.0, e + 3.75],
      [1.18, e + 3.85],
      [1.1, e + 3.95],
      [-2.4, e + 3.95],
    ]),
  );
  if (detail) {
    // Modillions under the corona, every metre round the hall.
    const mod = (): THREE.BufferGeometry => new THREE.BoxGeometry(0.34, 0.26, 0.8);
    for (let s = 0; s < 4; s++) {
      const along = s % 2 === 0 ? HALF_W : HALF_D;
      const out = s % 2 === 0 ? HALF_D : HALF_W;
      const F = M(0, 0, CZ, (s * Math.PI) / 2).multiply(M(0, 0, out));
      const n = Math.floor((along * 2) / 1.0);
      for (let i = 0; i <= n; i++) k.inst('exchange:modillion', L, mod, F.clone().multiply(M(-along + (i * along * 2) / n, e + 3.17, 0.4)));
    }
  }
  // The attic, set back from the cornice, with sunk panels over each bay and a coping.
  const a0 = ENT1;
  const set = 0.6;
  k.add(L, rectSweep(HALF_W - set, HALF_D - set, CZ, [[-3, a0], [0, a0], [0, ATTIC - 0.5], [0.2, ATTIC - 0.35], [0.28, ATTIC], [-3, ATTIC]]));
  // Over each column bay and each pavilion, a sunk panel in a raised frame.
  const bays = [...Array.from({ length: COLS - 1 }, (_, i) => -((COLS - 2) / 2) * COL_PITCH + i * COL_PITCH).filter((x) => Math.abs(x) > 5), -(PORTICO_HALF + HALF_W) / 2, (PORTICO_HALF + HALF_W) / 2];
  for (const x of bays) {
    const w = Math.abs(x) > PORTICO_HALF ? 6.4 : 3.6;
    k.box(L, w + 0.5, 0.22, 0.16, M(x, a0 + 1.0, FRONT - set + 0.08));
    k.box(L, w + 0.5, 0.22, 0.16, M(x, ATTIC - 1.3, FRONT - set + 0.08));
    for (const e of [-1, 1]) k.box(L, 0.22, ATTIC - 2.3 - a0 + 0.22, 0.16, M(x + (e * (w + 0.28)) / 2, (a0 + ATTIC - 0.3) / 2, FRONT - set + 0.08));
  }
  // The roof of the trading floor behind the attic, and its laylights either side of the dome: long hipped
  // glazed lights on steel glazing bars, the floor's own light coming up through them.
  k.box(X('roof'), D.width - 2.4, 0.2, D.depth - 2.4, M(0, ATTIC - 0.6, CZ));
  for (const s of [-1, 1]) {
    const x = s * (HALF_W - 9.5);
    const len = D.depth - 12;
    k.box(L, 10.4, 0.5, len + 0.4, M(x, ATTIC - 0.25, CZ));
    for (const side of [-1, 1]) {
      // Low enough that the attic's parapet hides them from the forecourt.
      const rake = Math.atan2(0.8, 4.8);
      const pitch = new THREE.Matrix4().makeRotationZ(-side * rake);
      k.add(X('skylight'), new THREE.BoxGeometry(Math.hypot(4.8, 0.8), 0.06, len), M(x + side * 2.4, ATTIC - 0.1 + 0.4, CZ).multiply(pitch), false);
      for (let i = 0; i <= 14; i++) k.inst('exchange:glazing-bar', X('steel'), () => new THREE.BoxGeometry(Math.hypot(4.8, 0.8), 0.12, 0.08), M(x + side * 2.4, ATTIC + 0.36, CZ - len / 2 + (i * len) / 14).multiply(pitch));
    }
    k.box(X('steel'), 0.2, 0.2, len, M(x, ATTIC + 0.72, CZ));
  }
}

/** The clock over the entrance, in an aedicule rising through the attic: pilasters, a segmental pediment, an opal face lit from behind. */
function aedicule(k: Kit): { y: number; z: number } {
  const L = X('limestone');
  const z = FRONT - 0.6;
  const y = (ENT1 + ATTIC) / 2 + 0.6;
  k.box(L, 8.4, ATTIC + 2.2 - ENT1, 1.4, M(0, (ENT1 + ATTIC + 2.2) / 2, z));
  for (const s of [-1, 1]) {
    k.box(L, 0.9, ATTIC + 1.6 - ENT1, 0.5, M(s * 3.7, (ENT1 + ATTIC + 1.6) / 2, z + 0.9));
    k.box(L, 1.2, 0.4, 0.7, M(s * 3.7, ATTIC + 1.8, z + 0.95));
  }
  // The segmental pediment: an arc of moulded stone over the clock.
  const arc = new THREE.Shape();
  const R = 6.2;
  const span = 4.6;
  const a = Math.asin(span / R);
  arc.absarc(0, -R * Math.cos(a), R, Math.PI / 2 + a, Math.PI / 2 - a, true);
  arc.absarc(0, -R * Math.cos(a), R - 0.6, Math.PI / 2 - a, Math.PI / 2 + a, false);
  arc.closePath();
  k.add(L, new THREE.ExtrudeGeometry(arc, { depth: 1.0, bevelEnabled: false, curveSegments: 20 }), M(0, ATTIC + 2.0, z + 0.2));
  k.box(L, 9.6, 0.4, 1.6, M(0, ATTIC + 2.0, z + 0.4));
  // The bezel.
  k.add(X('brass'), new THREE.TorusGeometry(2.3, 0.14, 10, 64), M(0, y, z + 0.78), false);
  k.add(X('enamel'), new THREE.CircleGeometry(2.24, 64), M(0, y, z + 0.72), false);
  // Hour marks.
  for (let i = 0; i < 12; i++) {
    const t = (i / 12) * Math.PI * 2;
    const len = i % 3 === 0 ? 0.42 : 0.24;
    k.inst('exchange:hour-mark', X('iron'), () => new THREE.BoxGeometry(0.09, 1, 0.03), ME(Math.sin(t) * 1.88, y + Math.cos(t) * 1.88, z + 0.76, 0, 0, -t, 1, len, 1));
  }
  return { y, z: z + 0.8 };
}

/** The drum of clerestory windows, the shallow copper dome with standing-seam ribs, and the glazed lantern on its crown. */
function dome(k: Kit, detail: boolean, rand: () => number): void {
  const L = X('limestone');
  const seg = detail ? 64 : 32;
  // A square stone base on the roof, then the drum.
  k.box(L, DRUM_R * 2 + 3, DRUM0 - (ATTIC - 0.6), DRUM_R * 2 + 3, M(0, (DRUM0 + ATTIC - 0.6) / 2, DOME_Z));
  k.add(L, lathe([[0, DRUM0], [DRUM_R + 0.6, DRUM0], [DRUM_R + 0.6, DRUM0 + 0.4], [DRUM_R, DRUM0 + 0.5], [DRUM_R, DRUM1], [DRUM_R + 0.5, DRUM1 + 0.3], [DRUM_R + 0.7, DRUM1 + 0.7], [DRUM_R + 0.4, DOME0], [0, DOME0]], seg), M(0, 0, DOME_Z));
  const n = 16;
  for (let i = 0; i < n; i++) {
    const a = ((i + 0.5) / n) * Math.PI * 2;
    // A pier between each pair of windows, and a lit arched window in each bay.
    const b = (i / n) * Math.PI * 2;
    k.inst('exchange:drum-pier', L, () => new THREE.BoxGeometry(1.1, DRUM1 - DRUM0 - 0.5, 0.7), M(Math.sin(b) * (DRUM_R + 0.2), (DRUM0 + DRUM1 + 0.5) / 2, DOME_Z + Math.cos(b) * (DRUM_R + 0.2), b));
    k.pane('exchange:pane-drum', 'window', M(Math.sin(a) * (DRUM_R + 0.02), DRUM0 + 0.6 + 2.4, DOME_Z + Math.cos(a) * (DRUM_R + 0.02), a, 2.3, 4.0, 1), paneData(0.85 + rand() * 0.15, 1, PANE_SASH));
  }
  // The copper cap and its ribs.
  const prof = domeProfile(detail ? 24 : 12);
  k.add(X('copper'), lathe([[0, 0], ...prof, [0, prof[prof.length - 1][1]]], seg), M(0, DOME0, DOME_Z), false);
  const ribs = 24;
  for (let i = 0; i < ribs; i++) {
    const a = (i / ribs) * Math.PI * 2;
    k.inst('exchange:rib', X('seam'), () => ribGeometry(prof, 0.22, 0.2), M(0, DOME0, DOME_Z, a));
  }
  // The lantern: a ring, eight colonnettes round lit glass, a small copper cap and a finial.
  const top = DOME0 + prof[prof.length - 1][1];
  k.add(L, lathe([[0, 0], [2.9, 0], [2.9, 0.55], [2.6, 0.7], [0, 0.7]], 32), M(0, top - 0.3, DOME_Z));
  const ly = top + 0.4;
  k.add(X('glow'), new THREE.CylinderGeometry(2.05, 2.05, 3.0, 24, 1, true), M(0, ly + 1.5, DOME_Z), false);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    k.inst('exchange:colonnette', L, () => new THREE.CylinderGeometry(0.17, 0.2, 3.0, 10), M(Math.sin(a) * 2.25, ly + 1.5, DOME_Z + Math.cos(a) * 2.25));
  }
  k.add(L, lathe([[0, 0], [2.7, 0], [2.7, 0.35], [2.5, 0.5], [0, 0.5]], 32), M(0, ly + 3.0, DOME_Z));
  k.add(X('copper'), lathe([[0, 0], [2.5, 0], [2.2, 0.6], [1.5, 1.15], [0.6, 1.45], [0, 1.5]], 32), M(0, ly + 3.5, DOME_Z), false);
  k.add(X('brass'), lathe([[0, 0], [0.22, 0], [0.3, 0.3], [0.12, 0.6], [0.2, 0.9], [0.05, 2.0], [0, 2.1]], 16), M(0, ly + 4.95, DOME_Z), false);
}

// ---------------------------------------------------------------- the forecourt

/** The four lamp standards: a granite pedestal, a fluted cast-iron post and a cross of five globes. */
function standards(k: Kit): void {
  const post = (): THREE.BufferGeometry => lathe([[0, 0], [0.42, 0], [0.42, 0.3], [0.3, 0.5], [0.26, 1.2], [0.2, 1.4], [0.17, 5.8], [0.24, 6.0], [0.16, 6.2], [0.16, 6.6], [0, 6.6]], 16);
  for (const l of CIVIC_LAMPS) {
    k.box(X('granite'), 1.6, 0.5, 1.6, M(l.x, 0.25, l.z));
    k.box(X('granite'), 1.25, 1.0, 1.25, M(l.x, 1.0, l.z));
    k.box(X('granite'), 1.5, 0.2, 1.5, M(l.x, 1.6, l.z));
    k.inst('exchange:lamp-post', X('iron'), post, M(l.x, 1.7, l.z));
    for (let a = 0; a < 4; a++) {
      const r = (a * Math.PI) / 2 + Math.PI / 4;
      k.inst('exchange:lamp-arm', X('iron'), () => new THREE.BoxGeometry(1.1, 0.09, 0.09), M(l.x + Math.cos(r) * 0.55, 7.9, l.z - Math.sin(r) * 0.55, r));
      k.inst('exchange:globe-cup', X('iron'), () => lathe([[0, 0], [0.16, 0], [0.22, 0.12], [0, 0.12]], 12), M(l.x + Math.cos(r) * 1.08, 7.9, l.z - Math.sin(r) * 1.08));
    }
    k.inst('exchange:globe-cup', X('iron'), () => lathe([[0, 0], [0.16, 0], [0.22, 0.12], [0, 0.12]], 12), M(l.x, 8.35, l.z));
    // Five opal globes, lit.
    const globe = (): THREE.BufferGeometry => new THREE.SphereGeometry(0.36, 16, 12);
    for (let a = 0; a < 4; a++) {
      const r = (a * Math.PI) / 2 + Math.PI / 4;
      k.inst('exchange:globe', X('globe'), globe, M(l.x + Math.cos(r) * 1.08, 8.3, l.z - Math.sin(r) * 1.08), undefined, false);
    }
    k.inst('exchange:globe', X('globe'), globe, M(l.x, 8.78, l.z), undefined, false);
  }
}

/** The fountain's stone: a moulded kerb round the basin, a pier, a lower and an upper bowl on a turned stem. */
function fountainStone(k: Kit): void {
  const L = X('limestone');
  const r = FOUNTAIN.radius;
  k.add(L, lathe([[r - 0.9, 0.0], [r, 0.0], [r, 0.12], [r - 0.08, 0.2], [r - 0.08, 0.56], [r + 0.08, 0.66], [r + 0.08, 0.82], [r - 0.95, 0.82], [r - 0.95, 0.3]], 72), M(FOUNTAIN.x, 0, FOUNTAIN.z));
  k.add(X('granite'), new THREE.CircleGeometry(r - 0.9, 48).rotateX(-Math.PI / 2), M(FOUNTAIN.x, 0.18, FOUNTAIN.z));
  // The centrepiece, turned: a pier, the lower bowl, a stem, the upper bowl and the nozzle.
  k.add(
    L,
    lathe(
      [
        [0, 0.15],
        [1.7, 0.15],
        [1.7, 0.5],
        [1.4, 0.65],
        [0.85, 0.9],
        [0.65, 1.4],
        [0.7, 1.75],
        [1.2, 1.95],
        [2.6, 2.15],
        [3.45, 2.3],
        [3.5, 2.5],
        [3.3, 2.55],
        [0.7, 2.4],
        [0.48, 2.7],
        [0.42, 3.4],
        [0.62, 3.9],
        [1.75, 4.25],
        [1.8, 4.45],
        [1.65, 4.48],
        [0.3, 4.35],
        [0.22, 4.9],
        [0.12, 5.05],
        [0, 5.05],
      ],
      48,
    ),
    M(FOUNTAIN.x, 0, FOUNTAIN.z),
  );
}

// ---------------------------------------------------------------- the build

export function makeExchange(quality: 'high' | 'medium', opts: ExchangeOptions = {}): Exchange {
  const detail = quality === 'high';
  const base = opts.materials ?? plainMaterials();
  const owned: THREE.Material[] = [];
  const own = <T extends THREE.Material>(m: T): T => (owned.push(m), m);
  const copper = own(copperMaterial());
  const seam = own(copperMaterial());
  seam.color.setHex(0x557f70);
  seam.roughness = 0.5;
  seam.customProgramCacheKey = () => 'palimpsest-exchange-copper-seam';
  // Old brass, dulled by the weather: it takes the light without mirroring the whole sunset.
  const brass = own(new THREE.MeshStandardMaterial({ color: 0x9c8048, metalness: 0.85, roughness: 0.42, envMapIntensity: 0.9 }));
  // Opal glass lit from behind: the clock reads at dusk, warm, under the bloom threshold.
  const enamel = own(new THREE.MeshStandardMaterial({ color: 0xf2ead8, roughness: 0.4, emissive: new THREE.Color(1.0, 0.86, 0.62), emissiveIntensity: 0.62 }));
  const iron = own(new THREE.MeshStandardMaterial({ color: 0x1a1c1e, metalness: 0.7, roughness: 0.45, envMapIntensity: 0.9 }));
  // The lantern's glass, lit from inside the hall.
  const glow = own(new THREE.MeshBasicMaterial({ color: new THREE.Color(1.25, 0.9, 0.55), side: THREE.DoubleSide }));
  const globe = own(new THREE.MeshBasicMaterial({ color: new THREE.Color(2.4, 1.75, 1.05) }));
  seam.side = THREE.DoubleSide;
  // Laylight glass over the lit trading floor: dark glass holding the sky, warm light coming up through it.
  const skylight = own(new THREE.MeshStandardMaterial({ color: 0x0e0c0a, roughness: 0.1, metalness: 0.1, emissive: new THREE.Color(1.0, 0.7, 0.4), emissiveIntensity: 0.26, envMapIntensity: 0.9 }));
  const mats: Record<string, THREE.Material> = { copper, seam, brass, enamel, iron, glow, globe, skylight };
  for (const key of USED) mats[key] = base[key];

  const rand = (() => {
    let s = 1234567;
    return () => (s = (s * 16807) % 2147483647) / 2147483647;
  })();

  const group = new THREE.Group();
  group.name = 'exchange';
  // The hall, modelled in its own numbers and stood at its scale; the forecourt (fountain, standards) at the city's.
  const hall = new THREE.Group();
  hall.name = 'exchange:hall-at-scale';
  hall.scale.setScalar(HALL_SCALE);
  hall.position.z = HALL_SHIFT;
  group.add(hall);

  const k = new Kit(mats as unknown as TowerMaterials);
  k.detail = detail;
  stylobate(k);
  // The hall's body behind the portico, and the two pavilions either side of it.
  const bodyH = ORDER;
  k.box(X('limestone'), D.width - 0.2, bodyH, INNER - 0.9 - D.z0, M(0, PODIUM + bodyH / 2, (D.z0 + INNER - 0.9) / 2));
  for (const s of [-1, 1]) {
    const w = HALF_W - PORTICO_HALF;
    k.box(X('limestone'), w - 0.1, bodyH, FRONT - INNER + 0.9, M((s * (PORTICO_HALF + HALF_W)) / 2, PODIUM + bodyH / 2, (FRONT + INNER - 0.9) / 2));
    pavilion(k, s, rand);
  }
  // The flanks and the back: the order carried round in pilasters, with tall windows on the trading floor.
  flank(k, M(HALF_W - 0.1, 0, CZ, Math.PI / 2), -HALF_D + 1.5, HALF_D - 1.5, 8, rand);
  flank(k, M(-HALF_W + 0.1, 0, CZ, -Math.PI / 2), -HALF_D + 1.5, HALF_D - 1.5, 8, rand);
  flank(k, M(0, 0, D.z0 + 0.1, Math.PI), -HALF_W + 1.5, HALF_W - 1.5, 12, rand);
  colonnade(k, detail);
  porticoWall(k, rand);
  entablature(k, detail);
  const clockAt = aedicule(k);
  dome(k, detail, rand);

  // The tote board's brass frames, along the frieze over the portico.
  const slotX = (i: number): number => (i - (EXCHANGE_SLOTS - 1) / 2) * SLOT_PITCH;
  for (let i = 0; i < EXCHANGE_SLOTS; i++) {
    k.inst('exchange:slot-frame', X('brass'), () => new THREE.BoxGeometry(1.56, 1.42, 0.1), M(slotX(i), BOARD_Y, FRONT + 0.05));
  }
  k.box(X('brass'), EXCHANGE_SLOTS * SLOT_PITCH + 0.6, 0.08, 0.16, M(0, FRIEZE1 - 0.08, FRONT + 0.08));
  k.box(X('brass'), EXCHANGE_SLOTS * SLOT_PITCH + 0.6, 0.08, 0.16, M(0, FRIEZE0 + 0.08, FRONT + 0.08));

  const built = k.build();
  built.name = 'exchange:hall';
  built.traverse((o) => {
    // The kit names meshes for towers; the exchange's own carry its name.
    o.name = o.name.replace(/^tower:/, 'exchange:hall:');
  });
  hall.add(built);
  const fk = new Kit(mats as unknown as TowerMaterials);
  fk.detail = detail;
  standards(fk);
  fountainStone(fk);
  const forecourt = fk.build();
  forecourt.name = 'exchange:forecourt';
  forecourt.traverse((o) => {
    o.name = o.name.replace(/^tower:/, 'exchange:forecourt:');
  });
  group.add(forecourt);

  // ---------------------------------------------------------------- the board
  const cardGeo = new THREE.PlaneGeometry(1.34, 0.66);
  const cardMat = own(boardMaterial('exchange:card', 0.18));
  const cards = new THREE.InstancedMesh(cardGeo, cardMat, EXCHANGE_SLOTS);
  cards.name = 'exchange:slots';
  const lampGeo = new THREE.SphereGeometry(0.075, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2).rotateX(Math.PI / 2);
  const lampMat = own(boardMaterial('exchange:lamp', 0.12));
  const lamps = new THREE.InstancedMesh(lampGeo, lampMat, EXCHANGE_SLOTS * LAMPS_PER_SLOT);
  lamps.name = 'exchange:lamps';
  const cardY = BOARD_Y + 0.25;
  const lampY = BOARD_Y - 0.42;
  for (let i = 0; i < EXCHANGE_SLOTS; i++) {
    cards.setMatrixAt(i, M(slotX(i), cardY, FRONT + 0.11));
    for (let j = 0; j < LAMPS_PER_SLOT; j++) lamps.setMatrixAt(i * LAMPS_PER_SLOT + j, M(slotX(i) + (j - (LAMPS_PER_SLOT - 1) / 2) * 0.2, lampY, FRONT + 0.1));
  }
  for (const m of [cards, lamps]) {
    m.castShadow = false;
    m.receiveShadow = false;
    m.instanceMatrix.needsUpdate = true;
    hall.add(m);
  }
  // A lit card, a dark card (posted, not yet taking bids), a closed brass shutter; a lit bid lamp and an unlit one.
  const CARD_LIT = new THREE.Color(2.1, 1.66, 1.1);
  const CARD_DARK = new THREE.Color(0.03, 0.032, 0.035);
  const SHUTTER = new THREE.Color(0.075, 0.06, 0.045);
  const LAMP_LIT = new THREE.Color(2.6, 1.2, 0.32);
  const LAMP_DARK = new THREE.Color(0.05, 0.04, 0.03);
  /** Each lamp's flare as it comes on: 1 when a bid lands, easing to 0. */
  const flare = new Float32Array(EXCHANGE_SLOTS * LAMPS_PER_SLOT);
  let board: BoardSlot[] = toteBoard([]);
  const labels = cardLabels(slotX, cardY);
  if (labels) hall.add(labels.object);

  const tmp = new THREE.Color();
  function paintLamps(): void {
    board.forEach((s, i) => {
      for (let j = 0; j < LAMPS_PER_SLOT; j++) {
        const n = i * LAMPS_PER_SLOT + j;
        lamps.setColorAt(n, j < s.lamps ? tmp.copy(LAMP_LIT).multiplyScalar(1 + 1.6 * flare[n]) : LAMP_DARK);
      }
    });
    lamps.instanceColor!.needsUpdate = true;
  }
  /** The posted jobs stand as one row centred under the clock, in the order they were posted; the empty slots either side. */
  const placeRow = (b: BoardSlot[]): void => {
    const n = b.filter((x) => x.state !== 'empty').length;
    const start = Math.floor((EXCHANGE_SLOTS - n) / 2);
    for (let i = 0; i < EXCHANGE_SLOTS; i++) {
      const at = (i - start + EXCHANGE_SLOTS) % EXCHANGE_SLOTS;
      cards.setMatrixAt(at, M(slotX(i), cardY, FRONT + 0.11));
      for (let j = 0; j < LAMPS_PER_SLOT; j++) lamps.setMatrixAt(at * LAMPS_PER_SLOT + j, M(slotX(i) + (j - (LAMPS_PER_SLOT - 1) / 2) * 0.2, lampY, FRONT + 0.1));
    }
    cards.instanceMatrix.needsUpdate = true;
    lamps.instanceMatrix.needsUpdate = true;
    labels?.place(start);
  };
  function setBoard(jobs: ReadonlyArray<BoardJob>): void {
    const next = toteBoard(jobs);
    placeRow(next);
    next.forEach((s, i) => {
      // A bid that lands on a slot already taking bids ticks its new lamp up bright; a slot's first paint does not.
      const was = board[i];
      if (was.state === 'bidding' && s.state === 'bidding' && was.label === s.label) for (let j = was.lamps; j < s.lamps; j++) flare[i * LAMPS_PER_SLOT + j] = 1;
      for (let j = s.lamps; j < LAMPS_PER_SLOT; j++) flare[i * LAMPS_PER_SLOT + j] = 0;
      cards.setColorAt(i, s.state === 'bidding' ? CARD_LIT : s.state === 'open' ? CARD_DARK : SHUTTER);
    });
    cards.instanceColor!.needsUpdate = true;
    board = next;
    paintLamps();
    labels?.draw(board);
  }
  setBoard([]);

  // ---------------------------------------------------------------- the fountain's water
  const water = { uTime: { value: 0 }, uFlow: { value: 1 } };
  const sheetMat = own(waterMaterial(water));
  const poolMat = own(poolMaterial(water));
  const jet = new THREE.Group();
  jet.name = 'exchange:jet';
  const waterGeos: THREE.BufferGeometry[] = [];
  const pools: THREE.BufferGeometry[] = [];
  const sheets: THREE.BufferGeometry[] = [];
  const addWater = (g: THREE.BufferGeometry, mat: THREE.Material): void => {
    for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal' && name !== 'uv') g.deleteAttribute(name);
    (mat === poolMat ? pools : sheets).push(g.index ? g.toNonIndexed() : g);
  };
  const waterMesh = (list: THREE.BufferGeometry[], mat: THREE.Material, into: THREE.Object3D, name: string): void => {
    const g = mergeGeometries(list, false)!;
    waterGeos.push(g);
    const m = new THREE.Mesh(g, mat);
    m.name = name;
    m.position.set(FOUNTAIN.x, 0, FOUNTAIN.z);
    m.castShadow = false;
    m.receiveShadow = false;
    m.renderOrder = 2;
    into.add(m);
  };
  // The basin and the two bowls hold still dark water, rippled while the fountain runs.
  addWater(new THREE.CircleGeometry(FOUNTAIN.radius - 0.92, 64).rotateX(-Math.PI / 2).translate(0, 0.62, 0), poolMat);
  addWater(new THREE.CircleGeometry(3.3, 40).rotateX(-Math.PI / 2).translate(0, 2.47, 0), poolMat);
  addWater(new THREE.CircleGeometry(1.64, 32).rotateX(-Math.PI / 2).translate(0, 4.4, 0), poolMat);
  // The jet rising from the nozzle and falling in a bell into the upper bowl; the sheets over each bowl's lip.
  addWater(new THREE.CylinderGeometry(0.06, 0.12, 2.6, 10, 8, true).translate(0, 5.05 + 1.3, 0), sheetMat);
  addWater(lathe([[0.06, 7.7], [0.32, 7.62], [0.62, 7.3], [0.92, 6.5], [1.18, 5.4], [1.36, 4.5]], 40), sheetMat);
  addWater(lathe([[1.82, 4.42], [1.95, 4.0], [2.05, 3.2], [2.1, 2.47]], 40), sheetMat);
  addWater(lathe([[3.52, 2.45], [3.7, 1.9], [3.82, 1.2], [3.86, 0.62]], 56), sheetMat);
  // Eight jets arcing in from the kerb.
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
    const p = (r: number, y: number): THREE.Vector3 => new THREE.Vector3(Math.sin(a) * r, y, Math.cos(a) * r);
    addWater(tube([p(8.9, 0.75), p(7.4, 2.3), p(5.9, 2.6), p(4.6, 1.6), p(4.0, 0.62)], 0.06, 0.1), sheetMat);
  }
  waterMesh(pools, poolMat, group, 'exchange:pools');
  waterMesh(sheets, sheetMat, jet, 'exchange:sheets');
  group.add(jet);
  let stopped = false;
  let time = 0;

  // ---------------------------------------------------------------- the clock's hands
  const hands = new THREE.Group();
  hands.name = 'exchange:clock';
  hands.position.set(0, clockAt.y, clockAt.z);
  const handGeo = { hour: new THREE.BoxGeometry(0.16, 1.25, 0.04).translate(0, 0.5, 0), minute: new THREE.BoxGeometry(0.1, 1.85, 0.04).translate(0, 0.78, 0) };
  const hour = new THREE.Mesh(handGeo.hour, iron);
  const minute = new THREE.Mesh(handGeo.minute, iron);
  minute.position.z = 0.04;
  hands.add(hour, minute);
  hall.add(hands);
  let shownMinute = -1;
  function setClock(): void {
    const now = new Date();
    const m = now.getHours() * 60 + now.getMinutes();
    if (m === shownMinute) return;
    shownMinute = m;
    minute.rotation.z = -(now.getMinutes() / 60) * Math.PI * 2;
    hour.rotation.z = -(((now.getHours() % 12) + now.getMinutes() / 60) / 12) * Math.PI * 2;
  }
  setClock();

  // ---------------------------------------------------------------- picking
  const pickables = new Map<THREE.Object3D, string>();
  const pickGeos: THREE.BufferGeometry[] = [];
  const pick = (g: THREE.BufferGeometry, x: number, y: number, z: number): void => {
    pickGeos.push(g);
    const m = new THREE.Mesh(g, base.pick);
    m.position.set(x, y, z);
    m.visible = false;
    m.name = 'exchange:pick';
    hall.add(m);
    pickables.set(m, JOBS_ROUTE);
  };
  pick(new THREE.BoxGeometry(D.width + 2, ATTIC + 2.2, D.depth + 2), 0, (ATTIC + 2.2) / 2, CZ);
  pick(new THREE.BoxGeometry(PORTICO_HALF * 2, PODIUM, D.stair + 1.6), 0, PODIUM / 2, FRONT + (D.stair + 1.6) / 2);
  pick(new THREE.CylinderGeometry(DRUM_R + 0.8, DRUM_R + 1.5, DOME0 + DOME_RISE + 7 - ATTIC, 24), 0, (ATTIC + DOME0 + DOME_RISE + 7) / 2, DOME_Z);

  return {
    object: group,
    pickables,
    setBoard,
    setStopped(s) {
      stopped = s;
    },
    slots: () => board.map((s) => ({ ...s })),
    fountainRunning: () => !stopped,
    update(dt) {
      time += dt;
      water.uTime.value = time;
      // The water falls still over a second or so when the engine stops, and rises again when it resumes.
      const want = stopped ? 0 : 1;
      water.uFlow.value = want > water.uFlow.value ? Math.min(1, water.uFlow.value + dt * 0.8) : Math.max(0, water.uFlow.value - dt * 0.9);
      jet.visible = !stopped || water.uFlow.value > 0.01;
      let any = false;
      for (let i = 0; i < flare.length; i++) {
        if (flare[i] <= 0) continue;
        flare[i] = Math.max(0, flare[i] - dt * 0.8);
        any = true;
      }
      if (any) paintLamps();
      setClock();
    },
    dispose() {
      for (const b of [built, forecourt]) b.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        m.geometry.dispose();
        if ((o as THREE.InstancedMesh).isInstancedMesh) (o as THREE.InstancedMesh).dispose();
      });
      for (const g of [...waterGeos, ...pickGeos, cardGeo, lampGeo, handGeo.hour, handGeo.minute]) g.dispose();
      cards.dispose();
      lamps.dispose();
      labels?.dispose();
      for (const m of owned) m.dispose();
    },
  };
}

// ---------------------------------------------------------------- the cards' words

/**
 * Each posted job's words on its card, sign-written in the index's serif:
 * dark on a lit card, faint gilt on a dark one. Drawn on one canvas (an atlas
 * of cells, a quad per slot), so only in the browser (null in node tests).
 */
function cardLabels(slotX: (i: number) => number, y: number): { object: THREE.Object3D; draw(board: BoardSlot[]): void; place(start: number): void; dispose(): void } | null {
  if (typeof document === 'undefined') return null;
  const COLS_A = 4;
  const ROWS_A = Math.ceil(EXCHANGE_SLOTS / COLS_A);
  const CW = 512;
  const CH = 192;
  const canvas = document.createElement('canvas');
  canvas.width = CW * COLS_A;
  canvas.height = CH * ROWS_A;
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  const pos: number[] = [];
  const uv: number[] = [];
  const w = 1.2;
  const h = 0.45;
  for (let i = 0; i < EXCHANGE_SLOTS; i++) {
    const cx = slotX(i);
    const u0 = (i % COLS_A) / COLS_A;
    const v1 = 1 - Math.floor(i / COLS_A) / ROWS_A;
    const u1 = u0 + 1 / COLS_A;
    const v0 = v1 - 1 / ROWS_A;
    const z = FRONT + 0.115;
    const quad = [
      [cx - w / 2, y - h / 2, z, u0, v0],
      [cx + w / 2, y - h / 2, z, u1, v0],
      [cx + w / 2, y + h / 2, z, u1, v1],
      [cx - w / 2, y - h / 2, z, u0, v0],
      [cx + w / 2, y + h / 2, z, u1, v1],
      [cx - w / 2, y + h / 2, z, u0, v1],
    ];
    for (const q of quad) {
      pos.push(q[0], q[1], q[2]);
      uv.push(q[3], q[4]);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  // Normals too: the ambient occlusion pass draws every mesh's normals, and a quad without them darkens the board.
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(new Float32Array(pos.length).map((_, i) => (i % 3 === 2 ? 1 : 0)), 3));
  const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, toneMapped: true });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'exchange:card-words';
  mesh.renderOrder = 1;
  let last: BoardSlot[] = [];
  const draw = (board: BoardSlot[]): void => {
    last = board;
    const g = canvas.getContext('2d');
    if (!g) return;
    g.clearRect(0, 0, canvas.width, canvas.height);
    board.forEach((s, i) => {
      if (s.state === 'empty' || !s.label) return;
      const x = (i % COLS_A) * CW;
      const yy = Math.floor(i / COLS_A) * CH;
      let size = 96;
      g.font = `500 ${size}px Newsreader, Georgia, serif`;
      size *= Math.min(1, (CW * 0.9) / Math.max(1, g.measureText(s.label).width));
      g.font = `500 ${size.toFixed(1)}px Newsreader, Georgia, serif`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      // Sign-writing: dark ink on a lit card, faint gilt on a dark one.
      g.fillStyle = s.state === 'bidding' ? 'rgba(38, 26, 14, 0.92)' : 'rgba(214, 176, 104, 0.5)';
      g.fillText(s.label, x + CW / 2, yy + CH / 2 + size * 0.04);
    });
    tex.needsUpdate = true;
  };
  void document.fonts?.load('500 96px Newsreader').then(() => draw(last), () => {});
  return {
    object: mesh,
    draw,
    // The words follow their cards along the row: the atlas cell of logical slot i sits over physical slot start + i.
    place(start) {
      mesh.position.x = start * SLOT_PITCH;
    },
    dispose() {
      geo.dispose();
      mat.dispose();
      tex.dispose();
    },
  };
}
