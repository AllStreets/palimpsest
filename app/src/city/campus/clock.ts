/**
 * The university's clock tower (Phase 4 Task 35): a collegiate gothic tower
 * of four stages, 48 m to the tip of its leaded cap, standing between the
 * two ranges where the cross walk passes through its foot under a pointed
 * arch. A gatehouse stage with angle buttresses, a stage of paired lancets,
 * the clock stage with a dial on every face, and a louvred belfry under a
 * battlemented parapet with pinnacles at its corners.
 *
 * The dials show his local time: eight hands in one instanced draw of the
 * campus's masonry, turned once a minute. After sunset the dials' paint is
 * lit from behind (the masonry shader's `dial` kind emits by its uDialLit
 * uniform, at a level under the bloom threshold); by day they are opal
 * glass in a stone ring. Sunset is read from the season and his clock, for
 * a temperate latitude, summer time allowed for.
 *
 * The masonry is built in the caller's Kit (and stamped into the site's
 * draw by the caller); only the hands are the tower's own object. Pure
 * three.js: tested in Node.
 */
import * as THREE from 'three';

import { Kit, M, piercedWall, pointedArch, rng } from '../tower/kit.js';
import { Gothic, type Opening, type Stages } from './gothic.js';
import { stamp } from './site.js';

/** The tower's measure: 48 m to the apex, four stages, 9 m square at the foot. */
export const TOWER = { height: 48, stages: 4, half: 4.5, dial: 2.3 } as const;

/** The stage lines: the gatehouse to 13, the lancet stage to 25, the clock stage to 34, the belfry to 42; the parapet and cap above. */
const STAGE = [0, 13, 25, 34, 42] as const;

// ---------------------------------------------------------------- time

/**
 * Sunrise and sunset in his local clock hours, by the season: six and
 * eighteen at the equinoxes, swinging an hour and three quarters either way
 * by the solstices (a temperate latitude), an hour later under summer time.
 */
export function sunTimes(d: Date): { rise: number; set: number } {
  const year = d.getFullYear();
  const doy = (d.getTime() - new Date(year, 0, 1).getTime()) / 864e5;
  const swing = 1.75 * Math.sin((2 * Math.PI * (doy - 80)) / 365.25);
  // Standard time is the larger offset of January and July (either hemisphere); summer time is the hour taken off it.
  const standard = Math.max(new Date(year, 0, 1).getTimezoneOffset(), new Date(year, 6, 1).getTimezoneOffset());
  const summer = Math.max(0, (standard - d.getTimezoneOffset()) / 60);
  return { rise: 6 - swing + summer, set: 18 + swing + summer };
}

/** True from sunset to sunrise, in his local time. */
export function afterSunset(d: Date): boolean {
  const h = d.getHours() + d.getMinutes() / 60;
  const { rise, set } = sunTimes(d);
  return h >= set || h < rise;
}

/** Where the hands point, in radians clockwise from twelve. */
export function handAngles(d: Date): { hour: number; minute: number } {
  const minute = (d.getMinutes() / 60) * Math.PI * 2;
  const hour = (((d.getHours() % 12) + d.getMinutes() / 60) / 12) * Math.PI * 2;
  return { hour, minute };
}

// ---------------------------------------------------------------- the tower

export interface ClockTowerOptions {
  /** The campus's masonry material: the hands draw in it, and its `userData.dialLit` uniform (if any) lights the dials. */
  masonry: THREE.Material;
  quality: 'high' | 'medium';
  seed?: string;
}

export interface ClockTower {
  /** The hands, the tower's one object of its own; the masonry went into the Kit. */
  group: THREE.Group;
  hands: THREE.InstancedMesh;
  /** Each dial's frame (x right, y up, z out of the face), in the Kit's frame. */
  faces: THREE.Matrix4[];
  /** Turns the hands to the minute and lights the dials after sunset. */
  update(): void;
  lit(): boolean;
  dispose(): void;
}

/** A hand: a tapered pointer a metre long from the boss to the tip, with a short counterweight tail, 6 cm thick. */
function handGeometry(): THREE.BufferGeometry {
  const s = new THREE.Shape([
    new THREE.Vector2(-0.07, -0.22),
    new THREE.Vector2(0.07, -0.22),
    new THREE.Vector2(0.075, 0),
    new THREE.Vector2(0.03, 0.78),
    new THREE.Vector2(0, 1),
    new THREE.Vector2(-0.03, 0.78),
    new THREE.Vector2(-0.075, 0),
  ]);
  const g = new THREE.ExtrudeGeometry(s, { depth: 0.06, bevelEnabled: false });
  // The boss over the arbor.
  const boss = new THREE.CylinderGeometry(0.13, 0.13, 0.1, 12).rotateX(Math.PI / 2).translate(0, 0, 0.03).toNonIndexed();
  const pos = new Float32Array(g.attributes.position.count * 3 + boss.attributes.position.count * 3);
  pos.set(g.attributes.position.array as Float32Array, 0);
  pos.set(boss.attributes.position.array as Float32Array, g.attributes.position.count * 3);
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.computeVertexNormals();
  g.dispose();
  boss.dispose();
  return stamp(out, 'slate', 0.55);
}

export function makeClockTower(k: Kit, clock: () => Date, o: ClockTowerOptions): ClockTower {
  const detail = o.quality === 'high';
  const g = new Gothic(k, rng(o.seed ?? 'clock'), detail);
  const H: number = TOWER.half;
  const D = 0.6;
  const base = k.base.clone();
  /** Face s of the tower: 0 is +z (the cross walk's far side), 1 +x, 2 -z, 3 -x; x along the face, y up, z out. */
  const face = (s: number, half = H): THREE.Matrix4 => M(0, 0, 0, (s * Math.PI) / 2).multiply(M(0, 0, half));
  /** A limestone string course round the tower at y, standing `out` proud, `h` tall. */
  const string = (y: number, out: number, h: number, half = H): void => g.box('limestone', 2 * (half + out), h, 2 * (half + out), M(0, y + h / 2, 0));
  /** A dark core filling a stage, so an opening never shows the sky through the tower. */
  const core = (y0: number, y1: number, half: number): void => g.box('slate', 2 * half - 0.3, y1 - y0, 2 * half - 0.3, M(0, (y0 + y1) / 2, 0), 0);

  // ---------------------------------------------------------------- stage 1: the gatehouse
  const plinthH = 0.8;
  const passW = 4.0;
  // The plinth, in two blocks either side of the passage.
  for (const s of [-1, 1]) g.box('limestone', H - passW / 2 - 0.2 + 0.3, plinthH, 2 * H + 0.3, M(s * (H + 0.15 - (H - passW / 2 + 0.1) / 2), plinthH / 2, 0));
  for (const s of [0, 2]) {
    const F = face(s);
    const hole = pointedArch(0, passW, 0, 3.8);
    g.add('brick', piercedWall(2 * H, STAGE[1], D, [hole]), F.clone().multiply(M(0, 0, -D)), 0.05);
    // The arch's orders of moulding, and a hood mould over it with a shield between.
    for (let i = 0; i < 3; i++) {
      const inner = passW + i * 0.44;
      const band = new THREE.Shape(pointedArch(0, inner + 0.36, 0, 3.8));
      band.holes.push(new THREE.Path(pointedArch(0, inner, 0.01, 3.8)));
      g.add('limestone', new THREE.ExtrudeGeometry(band, { depth: 0.1 + i * 0.1, bevelEnabled: false, curveSegments: 12 }), F.clone().multiply(M(0, 0, 0)));
    }
    // A lancet over the arch, lighting the room above the passage.
    const over: Opening = { u: 0, w: 1.2, y0: 8.6, y1: 10.8, pointed: true, lights: 1, lit: 0.7 };
    g.dress(F, over, D);
  }
  // The passage's side walls and the vault's soffit over it.
  for (const s of [1, 3]) {
    const F = face(s);
    const slit: Opening = { u: 0, w: 1.0, y0: 8.6, y1: 10.8, pointed: true, lights: 1, lit: 0.7 };
    g.wall(F, 2 * H, plinthH, STAGE[1] - plinthH, D, [slit], 0.05);
    g.box('brick', 2 * H - 2 * D, STAGE[1] - plinthH, 0.4, F.clone().multiply(M(0, plinthH + (STAGE[1] - plinthH) / 2, -passW / 2 - 0.2 - D)), 0.05);
  }
  g.box('limestone', passW + 0.8, 0.5, 2 * H - 2 * D, M(0, 3.8 + passW * Math.sin(Math.PI / 3) + 0.2, 0));
  // Walls between the passage and the outer faces (the gatehouse's solid flanks).
  for (const s of [-1, 1]) g.box('brick', H - passW / 2 - D, 3.8 + passW * Math.sin(Math.PI / 3) + 0.5, 2 * H - 2 * D, M(s * (passW / 2 + 0.2 + (H - passW / 2 - D) / 2), (3.8 + passW * Math.sin(Math.PI / 3) + 0.5) / 2, 0), 0.05);
  // Angle buttresses at the corners, three stages to the first string.
  const stages: Stages = [
    [plinthH, 5.2, 1.4, 1.6],
    [5.2, 9.6, 0.95, 1.36],
    [9.6, STAGE[1] - 0.2, 0.55, 1.12],
  ];
  for (let c = 0; c < 4; c++) {
    const sx = c < 2 ? 1 : -1;
    const sz = c % 2 === 0 ? 1 : -1;
    g.buttress(M(sx * (H - 0.4), 0, sz * (H - 0.4), Math.atan2(sx, sz)), 0, stages, plinthH);
  }
  string(STAGE[1] - 0.3, 0.3, 0.5);

  // ---------------------------------------------------------------- stage 2: paired lancets
  const H2 = H - 0.15;
  core(STAGE[1], STAGE[2], H2);
  for (let s = 0; s < 4; s++) {
    const F = face(s, H2);
    const lancets = [-1.35, 1.35].map((u): Opening => ({ u, w: 1.15, y0: STAGE[1] + 2.4, y1: STAGE[1] + 7.6, pointed: true, lights: 1, lit: 0.75 }));
    g.wall(F, 2 * H2, STAGE[1], STAGE[2] - STAGE[1], D, lancets, 0.05);
    // Limestone quoins up the corners.
    for (const q of [-1, 1]) g.box('limestone', 0.5, STAGE[2] - STAGE[1], 0.5, F.clone().multiply(M(q * (H2 - 0.25), (STAGE[1] + STAGE[2]) / 2, -0.25)));
  }
  string(STAGE[2] - 0.3, 0.35, 0.5, H2);

  // ---------------------------------------------------------------- stage 3: the clock
  const H3 = H - 0.3;
  core(STAGE[2], STAGE[3], H3);
  const faces: THREE.Matrix4[] = [];
  const dialY = (STAGE[2] + STAGE[3]) / 2 + 0.2;
  for (let s = 0; s < 4; s++) {
    const F = face(s, H3);
    g.wall(F, 2 * H3, STAGE[2], STAGE[3] - STAGE[2], D, [], 0.05);
    for (const q of [-1, 1]) g.box('limestone', 0.5, STAGE[3] - STAGE[2], 0.5, F.clone().multiply(M(q * (H3 - 0.25), (STAGE[2] + STAGE[3]) / 2, -0.25)));
    // A square limestone panel, chamfered to a ring round the dial; the dial's face sits a hand within the ring.
    const r = TOWER.dial;
    g.box('limestone', 2 * r + 1.6, 2 * r + 1.6, 0.26, F.clone().multiply(M(0, dialY, 0.13)));
    g.add('limestone', new THREE.TorusGeometry(r + 0.12, 0.2, 10, 56), F.clone().multiply(M(0, dialY, 0.3)));
    g.add('dial', new THREE.CircleGeometry(r, 56), F.clone().multiply(M(0, dialY, 0.3)));
    // A small gablet over the panel, so the clock reads as a feature and the rain runs off.
    g.add('limestone', new THREE.ConeGeometry(r + 0.9, 1.1, 4).rotateY(Math.PI / 4).scale(1, 1, 0.25), F.clone().multiply(M(0, dialY + r + 0.8 + 0.55, 0.16)));
    faces.push(base.clone().multiply(F).multiply(M(0, dialY, 0.34)));
  }
  // The clock stage's string, on corbels at high quality.
  string(STAGE[3] - 0.3, 0.4, 0.5, H3);
  if (detail) for (let s = 0; s < 4; s++) for (let u = -H3 + 0.6; u <= H3 - 0.6; u += 0.9) g.box('limestone', 0.3, 0.4, 0.4, face(s, H3).multiply(M(u, STAGE[3] - 0.55, 0.2)));

  // ---------------------------------------------------------------- stage 4: the belfry
  const H4 = H - 0.45;
  core(STAGE[3], STAGE[4], H4);
  for (let s = 0; s < 4; s++) {
    const F = face(s, H4);
    const bells = [-1.7, 1.7].map((u): Opening => ({ u, w: 1.9, y0: STAGE[3] + 1.6, y1: STAGE[3] + 5.4, pointed: true, lights: 1 }));
    const holes = bells.map((op) => pointedArch(op.u, op.w, op.y0 - STAGE[3], op.y1 - STAGE[3]));
    g.add('brick', piercedWall(2 * H4, STAGE[4] - STAGE[3], D, holes), F.clone().multiply(M(0, STAGE[3], -D)), 0.05);
    for (const op of bells) {
      // Louvres: slate slats raking down and out, in the depth of the opening, and a limestone sill and hood.
      for (let y = op.y0 + 0.35; y < op.y1 + 1.2; y += 0.55) g.add('slate', new THREE.BoxGeometry(op.w - 0.1, 0.08, 0.5).rotateX(-0.6), F.clone().multiply(M(op.u, y, -D / 2)), 0.1);
      g.box('slate', op.w - 0.1, op.y1 + 1.7 - op.y0, 0.08, F.clone().multiply(M(op.u, (op.y0 + op.y1 + 1.7) / 2, -D - 0.1)), 0);
      g.box('limestone', op.w + 0.36, 0.16, 0.34, F.clone().multiply(M(op.u, op.y0 - 0.08, -0.02)));
      if (detail) {
        const band = new THREE.Shape(pointedArch(0, op.w + 0.5, op.y1 - 0.6, op.y1));
        band.holes.push(new THREE.Path(pointedArch(0, op.w + 0.02, op.y1 - 0.58, op.y1)));
        g.add('limestone', new THREE.ExtrudeGeometry(band, { depth: 0.1, bevelEnabled: false, curveSegments: 10 }), F.clone().multiply(M(op.u, 0, 0)));
      }
    }
    for (const q of [-1, 1]) g.box('limestone', 0.5, STAGE[4] - STAGE[3], 0.5, F.clone().multiply(M(q * (H4 - 0.25), (STAGE[3] + STAGE[4]) / 2, -0.25)));
  }

  // ---------------------------------------------------------------- the parapet, pinnacles and cap
  const par0 = STAGE[4];
  // A corbel table and coping, then battlements round the top.
  g.box('limestone', 2 * H4 + 0.9, 0.5, 2 * H4 + 0.9, M(0, par0 + 0.25, 0));
  if (detail) for (let s = 0; s < 4; s++) for (let u = -H4 + 0.5; u <= H4 - 0.5; u += 0.75) g.box('limestone', 0.28, 0.5, 0.4, face(s, H4).multiply(M(u, par0 - 0.25, 0.2)));
  const HP = H4 + 0.45;
  g.box('limestone', 2 * HP, 0.3, 2 * HP, M(0, par0 + 0.65, 0));
  for (let s = 0; s < 4; s++) for (const u of [-2.4, -1.2, 0, 1.2, 2.4]) g.box('limestone', 0.6, 0.8, 0.3, face(s, HP).multiply(M(u, par0 + 1.2, -0.15)));
  // Octagonal pinnacles at the corners: a shaft, a crocketed spirelet, a ball.
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const P = M(sx * (HP - 0.55), par0 + 0.8, sz * (HP - 0.55), Math.PI / 8);
      g.add('limestone', new THREE.CylinderGeometry(0.5, 0.55, 2.8, 8).translate(0, 1.4, 0), P);
      g.add('limestone', new THREE.ConeGeometry(0.62, 2.6, 8).translate(0, 2.8 + 1.3, 0), P);
      if (detail) g.add('limestone', new THREE.SphereGeometry(0.16, 8, 6).translate(0, 5.6, 0), P);
    }
  }
  // The cap: a leaded pyramid from behind the parapet to the apex at 48 m, a finial on it.
  const cap0 = par0 + 0.8;
  const capH = TOWER.height - cap0 - 0.9;
  g.add('slate', new THREE.ConeGeometry((HP - 0.5) * Math.SQRT2, capH, 4).rotateY(Math.PI / 4).translate(0, cap0 + capH / 2, 0), undefined, 0);
  g.box('slate', 0.12, 0.9, 0.12, M(0, TOWER.height - 0.45, 0), 0);
  if (detail) g.add('slate', new THREE.SphereGeometry(0.2, 8, 6), M(0, TOWER.height - 0.25, 0), 0);

  // ---------------------------------------------------------------- the hands
  const handGeo = handGeometry();
  const hands = new THREE.InstancedMesh(handGeo, o.masonry, 8);
  hands.name = 'campus:hands';
  hands.castShadow = false;
  hands.receiveShadow = false;
  hands.frustumCulled = true;
  const group = new THREE.Group();
  group.name = 'campus:clock';
  group.add(hands);
  const HOUR = M(0, 0, 0, 0, 1.0, 1.35, 1);
  const MINUTE = M(0, 0, 0.08, 0, 0.8, 2.0, 1);
  const turn = new THREE.Matrix4();
  let shownMinute = -1;
  let lit = false;
  const update = (): void => {
    const now = clock();
    const minute = now.getHours() * 60 + now.getMinutes();
    const dark = afterSunset(now);
    if (dark !== lit || shownMinute < 0) {
      lit = dark;
      const u = (o.masonry.userData as { dialLit?: { value: number } }).dialLit;
      if (u) u.value = lit ? 1 : 0;
    }
    if (minute === shownMinute) return;
    shownMinute = minute;
    const a = handAngles(now);
    faces.forEach((F, i) => {
      // Clockwise seen from before the dial is a negative turn about its outward z.
      hands.setMatrixAt(2 * i, F.clone().multiply(turn.makeRotationZ(-a.hour)).multiply(HOUR));
      hands.setMatrixAt(2 * i + 1, F.clone().multiply(turn.makeRotationZ(-a.minute)).multiply(MINUTE));
    });
    hands.instanceMatrix.needsUpdate = true;
    hands.computeBoundingSphere();
  };
  return {
    group,
    hands,
    faces,
    update,
    lit: () => lit,
    dispose() {
      handGeo.dispose();
      hands.dispose();
    },
  };
}
