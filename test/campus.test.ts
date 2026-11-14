/**
 * The campus site (Phase 4 Task 34): the university's terrace, quads and
 * halls stand on the plot the engine took, inside their block, with the
 * ambient city kept off it, and the four halls drawn in the calls of one.
 * Pure three.js in Node: plain materials stand in for the window shader and
 * the masonry.
 */
import './kit-setup.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import * as THREE from 'three';

import { drawnMeshes } from '../app/src/city/batch.js';
import { createCampus, type CampusAnchors } from '../app/src/city/campus/index.js';
import { afterSunset, handAngles, makeClockTower, TOWER } from '../app/src/city/campus/clock.js';
import { buildHall, instanceHalls } from '../app/src/city/campus/halls.js';
import { campusLife, EMPTY_LIFE, FLICKER, foldLifeEvent, racingGenomes } from '../app/src/city/campus/life.js';
import { foldSchoolEvent, makeObservatory, OBSERVATORY, SCHOOL_MASTER_ROUTE, type ObservatoryState } from '../app/src/city/campus/observatory.js';
import type { People } from '../app/src/city/people.js';
import { Kit, PANE_READING } from '../app/src/city/tower/kit.js';
import { CAMPUS_HALF, campusPlaza, TERRACE } from '../app/src/city/campus/site.js';
import { PITCH, standingLots } from '../app/src/city/lots.js';
import type { TowerMaterials } from '../app/src/city/tower/kit.js';
import { DISTRICT_PITCH, districtOrigin } from '../shared/district-layout.js';
import { VOYAGE } from '../shared/school-rules.js';
import type { VoyageView } from '../shared/types.js';

/** Plain materials, one per key, so the campus builds in Node. */
function plainMaterials(): TowerMaterials {
  const made = new Map<string | symbol, THREE.Material>();
  return new Proxy({} as TowerMaterials, {
    get(_, key) {
      let m = made.get(key);
      if (!m) made.set(key, (m = new THREE.MeshStandardMaterial({ name: String(key) })));
      return m;
    },
  });
}

const plain = (): THREE.Material => new THREE.MeshStandardMaterial({ vertexColors: true });

function drawnTriangles(root: THREE.Object3D): number {
  let n = 0;
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !m.visible) return;
    const g = m.geometry;
    const tris = (g.index ? g.index.count : g.attributes.position.count) / 3;
    n += tris * ((m as THREE.InstancedMesh).isInstancedMesh ? (m as THREE.InstancedMesh).count : 1);
  });
  return n;
}

test('the campus stands on its slot’s origin, inside its block', () => {
  const origin = districtOrigin(5);
  const campus = createCampus({ quality: 'high', materials: plainMaterials(), masonry: plain() });
  campus.set(origin);
  campus.group.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(campus.group);
  // The whole campus, halls and terrace, stands within its own 240 m block, the streets round it kept clear.
  const half = DISTRICT_PITCH / 2 - 8;
  assert.ok(box.min.x >= origin.x - half - 1e-6 && box.max.x <= origin.x + half + 1e-6, `within the block in x (${box.min.x.toFixed(1)}..${box.max.x.toFixed(1)} round ${origin.x})`);
  assert.ok(box.min.z >= origin.z - half - 1e-6 && box.max.z <= origin.z + half + 1e-6, `within the block in z (${box.min.z.toFixed(1)}..${box.max.z.toFixed(1)} round ${origin.z})`);
  assert.ok(box.min.y >= -0.5, 'nothing below the street');
  // The terrace stands 6 m up, and the halls on it.
  assert.equal(TERRACE, 6);
  assert.ok(box.max.y > TERRACE + 12, `the halls rise above the terrace (${box.max.y.toFixed(1)} m)`);
  // Every anchor for the later buildings is on the terrace, inside the block.
  const anchors: CampusAnchors = campus.anchors();
  for (const [name, p] of Object.entries(anchors) as Array<[keyof CampusAnchors, THREE.Vector3]>) {
    assert.ok(Math.abs(p.x - origin.x) <= CAMPUS_HALF && Math.abs(p.z - origin.z) <= CAMPUS_HALF, `${name} stands inside the campus`);
    assert.ok(Math.abs(p.y - TERRACE) < 1e-6, `${name} stands on the terrace`);
  }
  // Moved, it goes whole, anchors and all.
  const other = districtOrigin(4);
  campus.set(other);
  // Slot 4 stands on the same side of the city as slot 5, so the campus keeps its yaw and the gate moves by exactly the shift.
  const moved = campus.anchors().gate;
  assert.ok(Math.abs(moved.x - anchors.gate.x - (other.x - origin.x)) < 1e-6 && Math.abs(moved.z - anchors.gate.z - (other.z - origin.z)) < 1e-6, `the gate moves with the campus (${moved.x.toFixed(1)}, ${moved.z.toFixed(1)})`);
  campus.dispose();
});

test('the gate faces the city, whichever side of it the campus stands', () => {
  for (const slot of [0, 1, 2, 3, 6, 11]) {
    const origin = districtOrigin(slot);
    const campus = createCampus({ quality: 'medium', materials: plainMaterials(), masonry: plain() });
    campus.set(origin);
    const gate = campus.anchors().gate;
    // The gate is on the campus's edge toward the centre of the city: nearer the civic plaza than the origin is.
    assert.ok(Math.hypot(gate.x, gate.z) < Math.hypot(origin.x, origin.z) - 50, `slot ${slot}: the gate at (${gate.x.toFixed(0)}, ${gate.z.toFixed(0)}) faces the centre from (${origin.x}, ${origin.z})`);
    campus.dispose();
  }
});

test('no ambient lot overlaps it, and no lamp or lantern stands on it', () => {
  const origin = districtOrigin(4);
  const plaza = campusPlaza(origin);
  const bi = Math.round(origin.x / PITCH);
  const bj = Math.round(origin.z / PITCH);
  let lots = 0;
  for (let i = bi - 3; i <= bi + 3; i++) {
    for (let j = bj - 3; j <= bj + 3; j++) {
      for (const lot of standingLots(i, j, [plaza])) {
        lots++;
        const dx = Math.abs(lot.x - origin.x) - lot.w / 2;
        const dz = Math.abs(lot.z - origin.z) - lot.d / 2;
        assert.ok(dx >= CAMPUS_HALF || dz >= CAMPUS_HALF, `lot at (${lot.x}, ${lot.z}) ${lot.w}x${lot.d} stays off the campus`);
      }
    }
  }
  assert.ok(lots > 20, `the blocks round the campus still stand (${lots} lots)`);
  // A terrace is a court for the lots and the lamps (grid.ts keeps them off a court), but carries none of a
  // quarter's court lanterns on its top and is never paved by the ground: the flag the grid and the scene read.
  assert.ok(plaza.court !== undefined && plaza.court >= CAMPUS_HALF && plaza.terrace === true, 'the campus is a terrace court');
});

test('four halls cost the calls of one', () => {
  const materials = plainMaterials();
  const one = buildHall({ quality: 'high', materials, masonry: plain(), seed: 'campus' });
  const single = instanceHalls(one, [new THREE.Matrix4()]);
  const four = instanceHalls(one, [0, 1, 2, 3].map((i) => new THREE.Matrix4().makeTranslation(i * 80, 0, 0)));
  assert.equal(drawnMeshes(four.group), drawnMeshes(single.group), `four halls draw in as many calls as one (${drawnMeshes(four.group)})`);
  assert.ok(drawnMeshes(four.group) <= 2, `a hall is one masonry draw and one of panes (${drawnMeshes(four.group)})`);
  assert.equal(drawnTriangles(four.group), 4 * drawnTriangles(single.group), 'and four times the triangles');
  // Light enough that four of them, three passes each, stay under the campus's 900k triangles.
  assert.ok(drawnTriangles(single.group) < 60_000, `a hall is under 60k triangles (${drawnTriangles(single.group).toFixed(0)})`);
  // The windows are lit panes in the tower window shader, a pane per light.
  let panes = 0;
  four.group.traverse((o) => {
    const im = o as THREE.InstancedMesh;
    if (im.isInstancedMesh && (im.material as THREE.Material).name === 'window') panes += im.count;
  });
  assert.ok(panes >= 4 * 40, `the four halls carry their windows (${panes} panes)`);
  single.dispose();
  four.dispose();
  one.dispose();
});

test('the whole campus draws in at most 6 calls a pass, at high and at medium', () => {
  for (const quality of ['high', 'medium'] as const) {
    const campus = createCampus({ quality, materials: plainMaterials(), masonry: plain() });
    campus.set(districtOrigin(2));
    // The site with the library's, the tower's and the observatory's masonry, the halls, the panes, the clock's
    // hands, the dome's shutter and its telescope.
    assert.ok(drawnMeshes(campus.group) <= 6, `${quality}: the campus draws in ${drawnMeshes(campus.group)} meshes`);
    assert.ok(drawnTriangles(campus.group) < 300_000, `${quality}: ${drawnTriangles(campus.group).toFixed(0)} triangles a pass`);
    campus.dispose();
  }
});

test('a disposed campus lets go of every geometry it made', () => {
  const campus = createCampus({ quality: 'high', materials: plainMaterials(), masonry: plain() });
  campus.set(districtOrigin(3));
  const geometries = new Set<THREE.BufferGeometry>();
  campus.group.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) geometries.add(m.geometry);
  });
  assert.ok(geometries.size >= 3, `the site, the halls and the panes (${geometries.size} geometries)`);
  let disposed = 0;
  for (const g of geometries) g.addEventListener('dispose', () => disposed++);
  campus.dispose();
  assert.equal(disposed, geometries.size, 'each geometry disposed once');
  // The lamps are in the site's draw: lit heads that cost no call of their own.
  assert.equal(drawnMeshes(campus.group), 6, 'and the group still names only its six meshes');
});

/** A clock tower built in Node: a Kit of plain materials, a plain masonry whose userData carries the dial's emission as the app's does. */
function tower(at: Date): ReturnType<typeof makeClockTower> & { masonry: THREE.Material } {
  const masonry = plain();
  masonry.userData.dialLit = { value: 0 };
  const k = new Kit(plainMaterials());
  const t = makeClockTower(k, () => at, { masonry, quality: 'high' });
  return Object.assign(t, { masonry });
}

test('the hands point at 10:10 for 10:10', () => {
  const at = new Date(2026, 10, 12, 10, 10);
  // Clockwise from twelve: the minute hand at two, the hour hand a sixth of the way from ten to eleven.
  const a = handAngles(at);
  assert.ok(Math.abs(a.minute - Math.PI / 3) < 1e-9, `the minute hand at two (${a.minute})`);
  assert.ok(Math.abs(a.hour - ((10 + 10 / 60) / 12) * Math.PI * 2) < 1e-9, `the hour hand past ten (${a.hour})`);
  const t = tower(at);
  t.update();
  // Four faces, two hands each, in one instanced draw; each hand's up, taken back into its dial's frame, points its way.
  assert.equal(t.hands.count, 8, 'eight hands');
  assert.equal(t.faces.length, 4, 'four dials');
  const m = new THREE.Matrix4();
  const up = new THREE.Vector3();
  const origin = new THREE.Vector3();
  for (let f = 0; f < 4; f++) {
    const inv = t.faces[f].clone().invert();
    for (const [i, want] of [[0, a.hour], [1, a.minute]] as Array<[number, number]>) {
      t.hands.getMatrixAt(f * 2 + i, m);
      // The hand's own +y, as a direction in the dial's frame (x right, y up, z out of the face).
      up.set(0, 1, 0).applyMatrix4(m).sub(origin.set(0, 0, 0).applyMatrix4(m)).applyMatrix4(new THREE.Matrix4().extractRotation(inv));
      const got = Math.atan2(up.x, up.y);
      const diff = Math.abs(Math.atan2(Math.sin(got - want), Math.cos(got - want)));
      assert.ok(diff < 1e-6, `face ${f} ${i === 0 ? 'hour' : 'minute'} hand points at ${((got / Math.PI) * 180).toFixed(1)} deg, wanted ${((want / Math.PI) * 180).toFixed(1)}`);
    }
  }
  // The hands turn with the time: an hour later the hour hand has moved a twelfth of the way round.
  const later = tower(new Date(2026, 10, 12, 11, 10));
  later.update();
  later.hands.getMatrixAt(0, m);
  const h2 = new THREE.Matrix4();
  t.hands.getMatrixAt(0, h2);
  assert.ok(!m.equals(h2), 'the hour hand has moved');
  t.dispose();
  later.dispose();
});

test('the faces emit only after sunset', () => {
  // Sunset by the season, in his local time: a December evening is dark by half past five, a June one not at five.
  assert.equal(afterSunset(new Date(2026, 11, 21, 17, 30)), true, 'December, half past five');
  assert.equal(afterSunset(new Date(2026, 11, 21, 10, 10)), false, 'December, ten past ten');
  assert.equal(afterSunset(new Date(2026, 5, 21, 17, 0)), false, 'June, five');
  assert.equal(afterSunset(new Date(2026, 5, 21, 22, 30)), true, 'June, half past ten');
  assert.equal(afterSunset(new Date(2026, 5, 21, 3, 0)), true, 'June, three in the morning');
  // The tower's dials: dark at ten past ten in the morning, lit at night, the emission a real one under the bloom threshold.
  const day = tower(new Date(2026, 10, 12, 10, 10));
  day.update();
  assert.equal(day.lit(), false, 'dark by day');
  assert.equal((day.masonry.userData.dialLit as { value: number }).value, 0, 'the dial kind emits nothing by day');
  const night = tower(new Date(2026, 10, 12, 22, 10));
  night.update();
  assert.equal(night.lit(), true, 'lit at night');
  assert.equal((night.masonry.userData.dialLit as { value: number }).value, 1, 'the dial kind emits at night');
  // A tower whose clock crosses sunset switches on without being rebuilt.
  let at = new Date(2026, 10, 12, 16, 0);
  const t = tower(at);
  t.update();
  assert.equal(t.lit(), false);
  at = new Date(2026, 10, 12, 19, 0);
  const t2 = makeClockTower(new Kit(plainMaterials()), () => at, { masonry: t.masonry, quality: 'medium' });
  t2.update();
  assert.equal(t2.lit(), true);
  // Four stages, 48 m: the tallest piece of masonry on the campus.
  assert.equal(TOWER.height, 48);
  assert.equal(TOWER.stages, 4);
  day.dispose();
  night.dispose();
  t.dispose();
  t2.dispose();
});

// ---------------------------------------------------------------- the observatory (Task 36)

/** An observatory built in Node: a Kit of plain materials, a plain masonry whose userData carries the uniforms the app's does. */
function observatory(): ReturnType<typeof makeObservatory> & { masonry: THREE.Material } {
  const masonry = plain();
  masonry.userData.slitLit = { value: 0 };
  masonry.userData.plateLit = { value: 0 };
  const k = new Kit(plainMaterials());
  const ob = makeObservatory(k, { masonry, quality: 'high' });
  return Object.assign(ob, { masonry });
}

const shut: ObservatoryState = { training: false, masterTrusted: false, version: 0 };

test('the slit opens on train.started for nets and closes on train.ended', () => {
  // The ledger's events fold into the observatory's state: a nets train running opens it, its end closes it;
  // a LoRA or an arena run is not the nets learning. The master's trained and promoted versions set the plate.
  const started = (id: string, kind: string): { type: string; data: unknown } => ({ type: 'train.started', data: { train: { id, kind, status: 'running' } } });
  const ended = (id: string, kind: string): { type: string; data: unknown } => ({ type: 'train.ended', data: { train: { id, kind, status: 'done' } } });
  let s = foldSchoolEvent(shut, started('t1', 'nets'));
  assert.equal(s.training, true, 'train.started for nets opens');
  s = foldSchoolEvent(s, started('t2', 'lora'));
  s = foldSchoolEvent(s, ended('t1', 'nets'));
  assert.equal(s.training, false, 'train.ended for the nets closes, whatever else runs');
  assert.equal(foldSchoolEvent(shut, started('t3', 'arena')).training, false, 'an arena race is not the nets learning');
  s = foldSchoolEvent(shut, { type: 'net.trained', data: { netVersion: { net: 'master', version: 3, trusted: true } } });
  assert.deepEqual([s.version, s.masterTrusted], [3, false], 'a trained master looks at new sky but is not yet the one current');
  s = foldSchoolEvent(s, { type: 'net.promoted', data: { net: 'master', version: 3 } });
  assert.deepEqual([s.version, s.masterTrusted], [3, true], 'promoted, the trusted version is the master');
  s = foldSchoolEvent(s, { type: 'net.trained', data: { netVersion: { net: 'durability', version: 9, trusted: true } } });
  assert.deepEqual([s.version, s.masterTrusted], [3, true], 'another net is not the master');
  assert.equal(foldSchoolEvent(s, { type: 'job.posted', data: {} }), s, 'anything else leaves the state as it was');

  // The dome itself: shut, then told the nets train, it opens over a few seconds; the telescope turns meanwhile.
  const ob = observatory();
  ob.setState({ ...shut, training: true });
  assert.equal(ob.view().open, 0, 'shut when built');
  ob.update(1);
  const partly = ob.view().open;
  assert.ok(partly > 0 && partly < 1, `opening after a second (${partly.toFixed(2)})`);
  const a0 = ob.view().altitude;
  for (let i = 0; i < 40; i++) ob.update(0.5);
  assert.equal(ob.view().open, 1, 'open');
  assert.ok((ob.masonry.userData.slitLit as { value: number }).value > 0.9, 'the warm light inside is up');
  assert.notEqual(ob.view().altitude, a0, 'the telescope has turned');
  // The leaves have parted: the shutter stands clear of the slit at the top of the dome.
  const box = new THREE.Box3().setFromObject(ob.shutter);
  assert.ok(box.max.y < OBSERVATORY.centre + OBSERVATORY.dome * 0.98, `the leaves have swung aside (y to ${box.max.y.toFixed(2)} of ${OBSERVATORY.apex})`);
  // The train ends: the leaves close and the telescope stands still.
  ob.setState({ ...shut });
  for (let i = 0; i < 40; i++) ob.update(0.5);
  assert.equal(ob.view().open, 0, 'shut again');
  assert.equal((ob.masonry.userData.slitLit as { value: number }).value, 0, 'and dark inside');
  const a1 = ob.view().altitude;
  ob.update(2);
  assert.equal(ob.view().altitude, a1, 'the telescope turns only while training');
  const closed = new THREE.Box3().setFromObject(ob.shutter);
  assert.ok(closed.max.y > OBSERVATORY.apex, 'the leaves meet over the apex again');
  // Its own objects: the shutter and the telescope, two meshes; the masonry went into the Kit.
  assert.equal(drawnMeshes(ob.group), 2, `the observatory's own draws (${drawnMeshes(ob.group)})`);
  ob.dispose();
});

test('a thin master leaves it shut and dark', () => {
  const ob = observatory();
  ob.setState(shut);
  for (let i = 0; i < 10; i++) ob.update(0.5);
  const v = ob.view();
  assert.deepEqual([v.open, v.training, v.lit], [0, false, false]);
  assert.equal((ob.masonry.userData.plateLit as { value: number }).value, 0, 'the brass plate by the door is dark');
  assert.equal((ob.masonry.userData.slitLit as { value: number }).value, 0, 'nothing shows through the slit');
  // Trusted, the plate lights, with the dome still shut.
  ob.setState({ ...shut, masterTrusted: true, version: 2 });
  ob.update(0.5);
  assert.equal(ob.view().lit, true);
  assert.equal((ob.masonry.userData.plateLit as { value: number }).value, 1, 'the plate is lit while the master is trusted');
  assert.equal(ob.view().open, 0, 'and the dome stays shut');
  ob.dispose();
});

test('clicking the dome opens the school screen at the master', () => {
  const campus = createCampus({ quality: 'medium', materials: plainMaterials(), masonry: plain() });
  const origin = districtOrigin(2);
  campus.set(origin);
  campus.group.updateMatrixWorld(true);
  const dome = campus.anchors().dome;
  // A ray from above the campus down onto the dome's apex, tested against what the campus lets be picked.
  const ray = new THREE.Raycaster(new THREE.Vector3(dome.x, dome.y + 60, dome.z), new THREE.Vector3(0, -1, 0));
  ray.layers.enableAll();
  const hits = ray.intersectObjects([...campus.pickables.keys()], false);
  assert.ok(hits.length > 0, 'the dome is picked');
  assert.equal(campus.pickables.get(hits[0].object), SCHOOL_MASTER_ROUTE, 'and names the school screen at the master');
  assert.equal(SCHOOL_MASTER_ROUTE, '#/school/master');
  // The state reaches the dome through the campus.
  campus.setSchool({ training: true, masterTrusted: true, version: 1 });
  for (let i = 0; i < 40; i++) campus.update(0.5, 0, new THREE.Vector3(origin.x, 50, origin.z));
  assert.equal(campus.observatory().open, 1, 'the campus opens its observatory');
  campus.dispose();
});

// ---------------------------------------------------------------- campus life (Task 37)

/** A voyage as the school's ledger carries it: eight genomes racing in its current generation. */
function voyageOf(status: VoyageView['status'], generation = 2, population = 8): VoyageView {
  const scores: VoyageView['scores'] = [];
  for (let g = 1; g <= generation; g++) {
    for (let i = 0; i < population; i++) scores.push({ genome: `g${g}-${i}`, name: `Genome ${g}.${i}`, generation: g, mean: 0.5, lo: 0.4, hi: 0.6, parents: g > 1 ? [`g${g - 1}-${i}`] : [] });
  }
  return { id: 'voy-1', arena: 'arena-harbor-1', status, generation, of: 4, runs: { done: 137, of: 480 }, commissionedBy: null, scores, promoted: [], sealed: null, credits: 14.2, startedAt: '2026-11-11T22:00:00Z', endedAt: null };
}

test('a voyage of 8 lights 8 bays and its pause darkens them', () => {
  const campus = createCampus({ quality: 'high', materials: plainMaterials(), masonry: plain() });
  campus.set(districtOrigin(2));
  const life = campusLife(campus, { people: () => null, quality: 'high' });
  // The reading room has more bays than a voyage's population, and starts dark.
  assert.ok(campus.library.bays >= 8, `the reading room has ${campus.library.bays} bays`);
  assert.equal(life.view().lit, 0, 'dark before any voyage');
  // The ledger's fold: a voyage sailing with eight genomes in its generation races eight.
  let s = foldLifeEvent(EMPTY_LIFE, { type: 'voyage.started', data: { voyageId: 'voy-1', voyage: voyageOf('sailing', 1) } });
  assert.ok(s.voyage && s.voyage.status === 'sailing' && s.voyage.racing === 8, `eight racing (${JSON.stringify(s.voyage)})`);
  assert.equal(racingGenomes(voyageOf('sailing', 3, 6)), 6, 'the genomes of the current generation');
  assert.equal(racingGenomes({ ...voyageOf('sailing', 1), scores: [] }), VOYAGE.population, 'before the first run, the population');
  life.apply({ type: 'voyage.started', data: { voyageId: 'voy-1', voyage: voyageOf('sailing', 1) } });
  for (let i = 0; i < 20; i++) life.update(0.5, i * 0.5);
  const v = life.view();
  assert.equal(v.lit, 8, `eight bays lit (${v.bays.map((b) => b.toFixed(2)).join(' ')})`);
  // The light is in the panes' own instance colours: one instanced draw, no mesh added.
  let panes: THREE.InstancedMesh | null = null;
  campus.group.traverse((o) => {
    if (o.name === 'campus:panes') panes = o as THREE.InstancedMesh;
  });
  assert.ok(panes, 'the campus panes draw');
  const c = new THREE.Color();
  // A lit bay sits in the window shader's amber band (0.45 to 0.62, no two alike), a dark one at 0.04.
  const litPanes = campus.library.panes.filter((j) => {
    panes!.getColorAt(j, c);
    return c.r > 0.3;
  });
  assert.equal(litPanes.length, 8, 'eight panes carry the light');
  assert.ok(litPanes.every((j) => (panes!.getColorAt(j, c), c.r <= 0.75)), 'and none is blown out');
  assert.equal(drawnMeshes(campus.group), 6, 'and the campus still draws in six meshes');
  // The voyage pauses for the night (its train pauses): the bays go dark over a few seconds.
  life.apply({ type: 'train.paused', data: { train: { id: 'train-v1', kind: 'voyage', status: 'paused' } } });
  assert.equal(life.state().voyage?.status, 'paused');
  for (let i = 0; i < 20; i++) life.update(0.5, 10 + i * 0.5);
  assert.equal(life.view().lit, 0, 'dark while paused');
  // It sails again on the next night, then ends: dark again and no live voyage.
  life.apply({ type: 'train.started', data: { train: { id: 'train-v2', kind: 'voyage', status: 'running' } } });
  for (let i = 0; i < 20; i++) life.update(0.5, 20 + i * 0.5);
  assert.equal(life.view().lit, 8, 'lit again when it sails on');
  life.apply({ type: 'voyage.generation', data: { voyageId: 'voy-1', voyage: voyageOf('sailing', 3, 6) } });
  for (let i = 0; i < 20; i++) life.update(0.5, 30 + i * 0.5);
  assert.equal(life.view().lit, 6, 'a generation of six lights six');
  life.apply({ type: 'voyage.ended', data: { voyageId: 'voy-1', voyage: { ...voyageOf('done', 4), endedAt: '2026-11-13T04:00:00Z' } } });
  for (let i = 0; i < 20; i++) life.update(0.5, 40 + i * 0.5);
  assert.equal(life.view().lit, 0, 'dark when the voyage ends');
  assert.equal(life.state().voyage, null, 'no live voyage');
  // Other kinds of training do not touch the reading room.
  s = foldLifeEvent(EMPTY_LIFE, { type: 'train.started', data: { train: { id: 't', kind: 'nets', status: 'running' } } });
  assert.equal(s, EMPTY_LIFE, 'a nets train is the observatory, not the library');
  assert.equal(foldLifeEvent(EMPTY_LIFE, { type: 'job.posted', data: {} }), EMPTY_LIFE, 'anything else leaves the state as it was');
  life.dispose();
  campus.dispose();
});

test('trained nets and graduates are remembered for the inspector', () => {
  let s = foldLifeEvent(EMPTY_LIFE, { type: 'net.trained', data: { netVersion: { net: 'appraiser', version: 6, trusted: true, at: '2026-11-12T03:00:00Z' } } });
  s = foldLifeEvent(s, { type: 'net.trained', data: { netVersion: { net: 'router', version: 2, trusted: false } } });
  s = foldLifeEvent(s, { type: 'net.trained', data: { netVersion: { net: 'appraiser', version: 7, trusted: false } } });
  assert.deepEqual(s.nets.map((n) => [n.net, n.version, n.trusted]), [['appraiser', 7, false], ['router', 2, false]], 'the newest version of each net');
  s = foldLifeEvent(s, { type: 'graduate.made', data: { graduate: { id: 'mlx:grad-qwen25c7-1', model: 'mlx:grad-qwen25c7-1', base: 'qwen2.5-coder:7b', loraId: 'lora-1', sealed: { mean: 0.61, lo: 0.52, hi: 0.7, n: 40 }, baseSealed: { mean: 0.47, lo: 0.38, hi: 0.56, n: 40 }, vsBase: { diff: 0.14, lo: 0.06, hi: 0.22 }, examples: 212, arenas: ['arena-1'], at: '2026-11-12T05:00:00Z', agentId: null } } });
  assert.equal(s.graduates.length, 1);
  assert.equal(s.graduates[0].id, 'mlx:grad-qwen25c7-1');
  // Recorded twice (a replay), it is one graduate.
  const again = foldLifeEvent(s, { type: 'graduate.made', data: { graduate: { ...s.graduates[0], loraId: 'lora-1', sealed: { mean: 0.61, lo: 0.52, hi: 0.7, n: 40 }, baseSealed: { mean: 0.47, lo: 0.38, hi: 0.56, n: 40 }, vsBase: { diff: 0.14, lo: 0.06, hi: 0.22 }, arenas: [] } } });
  assert.equal(again.graduates.length, 1);
});

test('the campus walks its students, unlabelled, and lets them be picked up by the people', () => {
  const campus = createCampus({ quality: 'medium', materials: plainMaterials(), masonry: plain() });
  const origin = districtOrigin(2);
  campus.set(origin);
  const walks = campus.walks();
  assert.ok(walks.nodes.length >= 20 && walks.edges.length >= walks.nodes.length - 1, `a walk graph (${walks.nodes.length} nodes, ${walks.edges.length} edges)`);
  // Every node stands on the terrace inside the campus.
  for (const n of walks.nodes) {
    assert.ok(Math.abs(n[0] - origin.x) < CAMPUS_HALF && Math.abs(n[2] - origin.z) < CAMPUS_HALF, `node (${n[0].toFixed(0)}, ${n[2].toFixed(0)}) inside the campus`);
    assert.ok(Math.abs(n[1] - TERRACE) < 0.5, 'on the terrace');
  }
  // The approach from the street climbs the stair to the gate.
  const approach = campus.approach();
  assert.ok(approach.length >= 4, 'street, foot, landing, gate');
  assert.ok(Math.abs(approach[0][1]) < 0.2 && Math.abs(approach[approach.length - 1][1] - TERRACE) < 0.1, 'from the street up to the terrace');
  const gate = campus.anchors().gate;
  assert.ok(approach.some((p) => Math.hypot(p[0] - gate.x, p[2] - gate.z) < 1), 'through the gate');
  // The students are the people's walkers: handed over whenever they need a path, never with a plate.
  const given: Array<{ id: string; path: number[][] }> = [];
  const fakePeople = {
    setWalkers(ws: ReadonlyArray<{ id: string; path: ReadonlyArray<number[]> }>) {
      given.splice(0, given.length, ...ws.map((w) => ({ id: w.id, path: w.path.map((p) => [...p]) })));
    },
    walkers: () => given.map((w) => ({ id: w.id, arrived: true })),
  };
  const life = campusLife(campus, { people: () => fakePeople as unknown as People, quality: 'medium' });
  life.update(0.1, 0);
  assert.ok(given.length >= 6, `students on the walks (${given.length})`);
  for (const w of given) {
    assert.ok(w.path.length >= 2, 'each on a path');
    for (const p of w.path) assert.ok(Math.abs(p[0] - origin.x) < CAMPUS_HALF && Math.abs(p[2] - origin.z) < CAMPUS_HALF, 'that stays on the campus');
  }
  assert.equal(life.view().students, given.length);
  life.dispose();
  campus.dispose();
});

test('the lamplight breathes within five percent, and no student lingers at the gate', () => {
  const campus = createCampus({ quality: 'high', materials: plainMaterials(), masonry: plain() });
  campus.set(districtOrigin(2));
  const given = new Map<string, { path: number[][]; face?: number }>();
  const arrived = new Set<string>();
  const fakePeople = {
    setWalkers(ws: ReadonlyArray<{ id: string; path: ReadonlyArray<number[]>; face?: number; speed: number }>) {
      given.clear();
      for (const w of ws) given.set(w.id, { path: w.path.map((p) => [...p]), face: w.face });
    },
    walkers: () => [...given.keys()].map((id) => ({ id, arrived: arrived.has(id) })),
  };
  const life = campusLife(campus, { people: () => fakePeople as unknown as People, quality: 'high' });
  life.apply({ type: 'voyage.started', data: { voyageId: 'voy-1', voyage: voyageOf('sailing', 1) } });
  for (let i = 0; i < 30; i++) life.update(0.5, i * 0.5);
  // Lit, each bay's pane wanders slowly about its level, never further than FLICKER of it; the levels themselves hold.
  let panes: THREE.InstancedMesh | null = null;
  campus.group.traverse((o) => {
    if (o.name === 'campus:panes') panes = o as THREE.InstancedMesh;
  });
  const c = new THREE.Color();
  const read = (): number[] => campus.library.panes.slice(0, 8).map((j) => (panes!.getColorAt(j, c), c.r));
  const a = read();
  const seen = a.map((v) => [v, v]);
  for (let t = 15; t < 45; t += 0.25) {
    life.update(0.25, t);
    read().forEach((v, i) => {
      seen[i][0] = Math.min(seen[i][0], v);
      seen[i][1] = Math.max(seen[i][1], v);
    });
  }
  assert.ok(seen.every(([lo, hi]) => hi > lo), 'the light moves');
  assert.ok(seen.every(([lo, hi]) => (hi - lo) / ((hi + lo) / 2) <= 2 * FLICKER + 1e-6), `and within five percent either way (${seen.map(([lo, hi]) => (((hi - lo) / (hi + lo)) * 100).toFixed(1)).join(' ')})`);
  assert.equal(life.view().lit, 8, 'the levels under it hold');
  // Readers in the panes: the bays carry the reading-room style and each its own lamplight hue.
  const styles = new Set<number>();
  const hues = new Set<number>();
  for (const j of campus.library.panes) {
    panes!.getColorAt(j, c);
    styles.add(Math.round(c.b * 100) / 100);
    hues.add(Math.round(c.g * 100) / 100);
  }
  assert.deepEqual([...styles], [PANE_READING], 'every bay is a reading room');
  assert.ok(hues.size >= 8, `the bays' lamplight differs bay to bay (${hues.size} hues)`);
  // The students: none is sent to the gate or the stair's approach, and the walk the gate starts is theirs to pass, not to stand on.
  const gate = campus.anchors().gate;
  const approach = campus.approach();
  const nearGate = (p: number[]): boolean => Math.hypot(p[0] - gate.x, p[2] - gate.z) < 9 || approach.some((q) => Math.hypot(p[0] - q[0], p[2] - q[2]) < 3);
  let faced = 0;
  let gathered = 0;
  for (let round = 0; round < 60; round++) {
    for (const id of given.keys()) arrived.add(id);
    for (let i = 0; i < 20; i++) life.update(0.5, 100 + round * 10 + i * 0.5);
    for (const w of given.values()) {
      const end = w.path[w.path.length - 1];
      assert.ok(!nearGate(end), `no student stands at the gate (${end.map((v) => v.toFixed(0)).join(', ')})`);
      if (w.face !== undefined) faced++;
    }
    gathered = Math.max(gathered, ...life.view().gathers);
  }
  assert.ok(faced > 0, 'arrived, a student turns to look at something');
  assert.ok(gathered >= 2 && gathered <= 3, `two or three gather at a corner (${gathered})`);
  life.dispose();
  campus.dispose();
});
