import assert from 'node:assert/strict';
import { test } from 'node:test';

import * as THREE from 'three';

import { constructionState, ERA_TONE, FLOOD_TINT, floodRadiance, makeConstruction, makeConstructionField, makeHoist, netPanel, netTextures, searchRadiance, workLampRadiance } from '../app/src/city/construction.js';
import { BLOOM_THRESHOLD, EXPOSURE, FLOOD } from '../app/src/city/post.js';
import { workProgress } from '../engine/market/runs.js';
import type { SiteStage, SiteState } from '../shared/types.js';

const site = (stage: SiteStage, progress: number): SiteState => ({
  repo: 'acme/harbour',
  runId: 'run-1',
  jobId: 'job-1',
  agentId: 'priya-rao',
  firmId: 'quickset',
  stage,
  progress,
  size: 'medium',
  since: '2026-11-10T18:00:00.000Z',
});

const TOP = 100;
const HALF = 13;
const FH = 4.2;

/** World-space box of every drawn instance of an instanced mesh. */
function instanceBoxes(mesh: THREE.InstancedMesh): THREE.Box3[] {
  mesh.updateWorldMatrix(true, false);
  mesh.geometry.computeBoundingBox();
  const out: THREE.Box3[] = [];
  const m = new THREE.Matrix4();
  for (let i = 0; i < mesh.count; i++) {
    mesh.getMatrixAt(i, m);
    out.push(mesh.geometry.boundingBox!.clone().applyMatrix4(m).applyMatrix4(mesh.matrixWorld));
  }
  return out;
}

function part<T extends THREE.Object3D>(root: THREE.Object3D, name: string): T {
  const o = root.getObjectByName(name);
  assert.ok(o, `${name} exists`);
  return o as T;
}

/** Runs the construction's clock for `seconds` in display frames. */
function run(c: ReturnType<typeof makeConstruction>, seconds: number): boolean {
  let moved = false;
  for (let t = 0; t < seconds; t += 1 / 60) moved = c.update(1 / 60) || moved;
  return moved;
}

test('the crane stands on the tower top and the skeleton is at floor height', () => {
  const c = makeConstruction('high');
  c.set(site('crane', 0.05), TOP, HALF, FH);
  c.object.updateMatrixWorld(true);
  const crane = part(c.object, 'construction:crane');
  const at = crane.getWorldPosition(new THREE.Vector3());
  assert.ok(Math.abs(at.y - TOP) < 1e-6, `the crane's base is on the roof (${at.y})`);
  assert.ok(Math.abs(at.x) < HALF - 2 && Math.abs(at.z) < HALF - 2, 'the mast stands inside the footprint');
  // The mast reaches well above the new floor: the jib has to clear the frame it lifts steel into.
  const box = new THREE.Box3().setFromObject(crane);
  assert.ok(box.max.y > TOP + FH + 12, `the crane rises above the new floor (${box.max.y.toFixed(1)})`);

  const cols = part<THREE.InstancedMesh>(c.object, 'construction:columns');
  assert.ok(cols.count >= 2 && cols.count <= 4, `two to four columns stand at the crane stage (${cols.count})`);
  for (const b of instanceBoxes(cols)) {
    assert.ok(Math.abs(b.min.y - TOP) < 0.05, `a column starts on the roof (${b.min.y.toFixed(2)})`);
    assert.ok(Math.abs(b.max.y - (TOP + FH)) < 0.05, `and stands a floor high (${b.max.y.toFixed(2)})`);
    assert.ok(b.max.x <= HALF + 0.5 && b.min.x >= -HALF - 0.5 && b.max.z <= HALF + 0.5 && b.min.z >= -HALF - 0.5, 'on the floor plan');
  }
  assert.equal(part<THREE.InstancedMesh>(c.object, 'construction:beams').count, 0, 'no beams before the work starts');
  assert.equal(c.weld(), null, 'nobody welds before the work starts');
  c.dispose();
});

test('framing at progress 0.5 shows half the beams', () => {
  const c = makeConstruction('high');
  c.set(site('framing', 0.5), TOP, HALF, FH);
  const total = constructionState(site('framing', 0.5), TOP, HALF, FH).beams.total;
  assert.ok(total >= 24, `a floor's frame has a real number of beams (${total})`);
  const beams = part<THREE.InstancedMesh>(c.object, 'construction:beams');
  assert.equal(beams.count, Math.round(total / 2));
  for (const b of instanceBoxes(beams)) assert.ok(b.max.y <= TOP + FH + 0.05 && b.min.y >= TOP + FH - 1.2, 'beams frame the new floor at its top');
  // Every column of the floor stands by the time half its beams are in.
  assert.equal(part<THREE.InstancedMesh>(c.object, 'construction:columns').count, constructionState(site('framing', 0.5), TOP, HALF, FH).columns.total);
  // The rest of the frame follows the same mapping.
  c.set(site('framing', 0.2), TOP, HALF, FH);
  assert.equal(beams.count, Math.round(total * 0.2));
  c.set(site('framing', 1), TOP, HALF, FH);
  assert.equal(beams.count, total);
  // Netting hangs on the outer face while the frame goes up, and the sparks fly at the working edge.
  assert.ok(part(c.object, 'construction:netting').visible, 'netting hangs while framing');
  c.set(site('framing', 0.5), TOP, HALF, FH);
  run(c, 6);
  const w = constructionState(site('framing', 0.5), TOP, HALF, FH).weldAt;
  assert.ok(w, 'framing has a working edge');
  assert.ok(Math.abs(w[1] - (TOP + FH)) < 1.2, 'the weld is at the top of the new floor');
  c.dispose();
});

test('between progress events the frame holds still; only the sparks and the lamp move', () => {
  const c = makeConstruction('high');
  c.set(site('framing', 0.4), TOP, HALF, FH);
  run(c, 20);
  const snap = (): string => {
    c.object.updateMatrixWorld(true);
    const parts: number[] = [];
    c.object.traverse((o) => {
      if (o.name.startsWith('construction:spark') || o.name.startsWith('construction:lamp')) return;
      parts.push(...o.matrixWorld.elements.map((v) => Math.round(v * 1e4)));
      if ((o as THREE.InstancedMesh).isInstancedMesh) parts.push((o as THREE.InstancedMesh).count);
    });
    return parts.join(',');
  };
  const sparks = part<THREE.Mesh>(c.object, 'construction:sparks');
  const time = (): number => ((sparks.material as THREE.ShaderMaterial).uniforms.uTime.value as number);
  const before = snap();
  const t0 = time();
  assert.equal(run(c, 30), false, 'nothing that casts a shadow moves without an event');
  assert.equal(snap(), before, 'the frame, the crane, the trolley and the hook hold still');
  assert.ok(time() > t0 + 29, 'the sparks keep flying');

  // A progress step: one more beam goes in, the trolley traverses to it and the hook lifts.
  const trolley = part(c.object, 'construction:trolley');
  const hook = part(c.object, 'construction:hook');
  const x0 = trolley.position.x;
  const y0 = hook.position.y;
  c.set(site('framing', 0.46), TOP, HALF, FH);
  assert.ok(run(c, 0.5), 'the crane moves after a step');
  run(c, 12);
  const a = constructionState(site('framing', 0.4), TOP, HALF, FH);
  const b = constructionState(site('framing', 0.46), TOP, HALF, FH);
  assert.ok(b.beams.shown > a.beams.shown, 'the step adds beams');
  assert.ok(Math.abs(trolley.position.x - x0) > 0.05 || Math.abs(b.slew - a.slew) > 0.01, 'the trolley or the jib moves to the next beam');
  assert.ok(Math.abs(trolley.position.x - b.trolley) < 0.05, 'and settles over it');
  assert.ok(Math.abs(hook.position.y - b.hook) < 0.05 && b.hook !== undefined && y0 !== undefined, 'the hook settles where the step puts it');
  assert.equal(run(c, 5), false, 'then holds still again');
  c.dispose();
});

test('the arc flickers blue-white within the bloom budget, and only while framing', () => {
  const c = makeConstruction('high');
  c.set(site('framing', 0.5), TOP, HALF, FH);
  let lit = 0;
  let dark = 0;
  let peak = 0;
  for (let i = 0; i < 600; i++) {
    c.update(1 / 60);
    const w = c.weld();
    if (w && w.intensity > 0) {
      lit++;
      peak = Math.max(peak, w.intensity);
    } else dark++;
  }
  assert.ok(lit > 60 && dark > 30, `the arc strikes and breaks (${lit} lit, ${dark} dark frames)`);
  assert.ok(peak <= c.flickerPeak, `the flicker stays within its budget (${peak})`);
  c.set(site('inspecting', 0.8), TOP, HALF, FH);
  run(c, 1);
  assert.equal(c.weld(), null, 'no welding once inspection starts');
  assert.equal(part<THREE.InstancedMesh>(c.object, 'construction:beams').count, constructionState(site('framing', 1), TOP, HALF, FH).beams.total, 'the frame is complete for inspection');
  c.dispose();
});

test('a site set to null disposes its parts', () => {
  const c = makeConstruction('high');
  c.set(site('framing', 0.6), TOP, HALF, FH);
  const geos = new Set<THREE.BufferGeometry>();
  const mats = new Set<THREE.Material>();
  c.object.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.geometry) geos.add(m.geometry);
    if (m.material) for (const x of [m.material].flat()) mats.add(x);
  });
  assert.ok(geos.size > 5, `the site has parts (${geos.size})`);
  const disposed = new Set<unknown>();
  for (const g of geos) g.addEventListener('dispose', () => disposed.add(g));
  for (const m of mats) m.addEventListener('dispose', () => disposed.add(m));
  c.set(null, TOP, HALF, FH);
  assert.equal(c.object.children.length, 0, 'nothing stands');
  assert.equal(disposed.size, geos.size + mats.size, 'every geometry and material is released');
  assert.equal(c.weld(), null);
  // And it can stand again.
  c.set(site('crane', 0.1), TOP, HALF, FH);
  assert.ok(c.object.getObjectByName('construction:crane'));
  c.dispose();
});

test('the hoist mast reaches its height and its car rides it', () => {
  const h = makeHoist(60);
  const box = new THREE.Box3().setFromObject(part(h.object, 'hoist:mast'));
  assert.ok(Math.abs(box.max.y - 60) < 1.5 && box.min.y <= 0.01, `the mast runs from the ground to 60 m (${box.min.y}, ${box.max.y})`);
  const car = part(h.object, 'hoist:car');
  h.setCar(0);
  assert.ok(Math.abs(car.position.y) < 1e-6);
  h.setCar(57);
  assert.equal(car.position.y, 57);
  h.setCar(200);
  assert.ok(car.position.y <= 60, 'the car never rides off the top');
  h.dispose();
});

test('work progress follows real tool calls and tests run', () => {
  const p = (toolCalls: number, testsRun: number, turns = 0): number => workProgress({ toolCalls, testsRun, turns, filesChanged: 0, weightedTokens: 0, credits: 0, refusals: 0 }, 20);
  assert.equal(p(0, 0), 0.15, 'the frame starts at its first columns');
  assert.ok(p(4, 0) > p(0, 0), 'a tool call raises it');
  assert.ok(p(4, 3) > p(4, 0), 'tests run raise it');
  assert.ok(p(4, 0, 10) >= p(0, 0, 10), 'it never falls behind the turns');
  assert.equal(p(400, 400, 400), 0.7, 'the frame tops out where inspection takes over');
});

test('every live site is drawn in the same few batches, so more sites add no draw calls', () => {
  const field = makeConstructionField('high');
  const sites = [0, 1, 2].map((i) => {
    const c = makeConstruction('high');
    c.object.position.set(i * 400, 0, 0);
    c.set({ ...site(i === 2 ? 'crane' : 'framing', 0.5), repo: `acme/r${i}`, runId: `run-${i}` }, TOP + i * 20, HALF, FH);
    return c;
  });
  field.update(sites.slice(0, 1));
  const one = field.draws();
  field.update(sites);
  const three = field.draws();
  assert.ok(three <= 5, `three sites draw in at most five meshes (${three})`);
  assert.equal(three, one, 'a second and a third site add no draws');
  // Every part the sites show is drawn, at its place in the world.
  const steel = field.group.getObjectByName('field:steel') as THREE.BatchedMesh;
  let shown = 0;
  for (const c of sites) {
    c.object.traverse((o) => {
      const m = o as THREE.InstancedMesh;
      if (!m.isMesh || !['yellow', 'dark', 'ballast', 'glass', 'primer', 'deck', 'rope'].includes((m.material as THREE.Material).name)) return;
      let on = true;
      for (let p: THREE.Object3D | null = m; p; p = p.parent) on &&= p.visible;
      if (on) shown += m.isInstancedMesh ? m.count : 1;
    });
  }
  let drawn = 0;
  for (let i = 0; i < steel.instanceCount; i++) if (steel.getVisibleAt(i)) drawn++;
  assert.equal(drawn, shown, `the batch draws exactly the parts shown (${drawn})`);
  // A beam set by the next event shows in the batch; with no event, nothing is copied again.
  const before = sites[0].revision;
  for (let i = 0; i < 120; i++) for (const c of sites) c.update(1 / 60);
  field.update(sites);
  sites[0].set({ ...site('framing', 0.6), repo: 'acme/r0', runId: 'run-0' }, TOP, HALF, FH);
  assert.ok(sites[0].revision > before, 'an event bumps the site');
  field.update(sites);
  let after = 0;
  for (let i = 0; i < steel.instanceCount; i++) if (steel.getVisibleAt(i)) after++;
  const a = constructionState(site('framing', 0.5), TOP, HALF, FH);
  const b = constructionState(site('framing', 0.6), TOP, HALF, FH);
  const more = b.beams.shown - a.beams.shown + (b.decks.shown - a.decks.shown) + (b.columns.shown - a.columns.shown);
  assert.equal(after, drawn + more, `the step's steel is drawn (${more} more parts)`);
  for (const c of sites) c.dispose();
  field.update([]);
  assert.equal(field.draws(), 0, 'no sites, nothing drawn');
  field.dispose();
});

test('floodlights burn from the crane to the end of inspection, switched by stage, within the bloom budget', () => {
  const c = makeConstruction('high');
  for (const stage of ['crane', 'framing', 'inspecting'] as const) {
    c.set(site(stage, 0.5), TOP, HALF, FH);
    const f = c.floods();
    assert.equal(f.length, 2, `two floods burn while ${stage}`);
    for (const p of f) assert.ok(p.y > TOP + FH && p.y < TOP + FH + 4, 'on masts just above the working deck');
  }
  for (const stage of ['curing', 'waiting'] as const) {
    c.set(site(stage, 1), TOP, HALF, FH);
    assert.equal(c.floods().length, 0, `the floods are off once ${stage}`);
  }
  // Steel three metres from a head stays under the bloom threshold.
  const radiance = (FLOOD.peak / 9) * (0.6 / Math.PI) * EXPOSURE;
  assert.ok(radiance <= BLOOM_THRESHOLD, `lit steel ${radiance.toFixed(2)} stays under ${BLOOM_THRESHOLD}`);
  // Nothing about the floods follows a clock: a minute later they are where they were.
  c.set(site('framing', 0.5), TOP, HALF, FH);
  const at = c.floods().map((p) => p.toArray().join(','));
  for (let i = 0; i < 3600; i++) c.update(1 / 60);
  assert.deepEqual(c.floods().map((p) => p.toArray().join(',')), at);
  c.dispose();
});

test('the netting is a woven diamond mesh that sags between its ties', () => {
  const { map, alpha } = netTextures();
  const a = alpha.image.data as Uint8Array;
  let cord = 0;
  for (let i = 1; i < a.length; i += 4) if (a[i] > 128) cord++;
  const cover = cord / (a.length / 4);
  assert.ok(cover > 0.08 && cover < 0.4, `a net, mostly holes (${(cover * 100).toFixed(0)}% cord)`);
  const m = map.image.data as Uint8Array;
  const tones = new Set<number>();
  for (let i = 0; i < m.length; i += 4) if (a[i + 1] > 128) tones.add(m[i]);
  assert.ok(tones.size > 10, 'its cords carry the twist of the rope, not one flat tone');
  const g = netPanel(6.5, 5);
  const pos = g.attributes.position as THREE.BufferAttribute;
  let topMid = Infinity;
  let topEnd = -Infinity;
  for (let i = 0; i < pos.count; i++) {
    if (pos.getY(i) < 4.5) continue;
    if (Math.abs(pos.getX(i)) < 0.4) topMid = Math.min(topMid, pos.getY(i));
    if (Math.abs(Math.abs(pos.getX(i)) - 3.25) < 1e-6) topEnd = Math.max(topEnd, pos.getY(i));
  }
  assert.ok(topEnd - topMid > 0.05 && topEnd - topMid < 0.3, `the top rope sags between ties (${(topEnd - topMid).toFixed(2)} m)`);
  for (const t of [map, alpha]) t.dispose();
  g.dispose();
});

test('setting a site to the state it already shows changes nothing', () => {
  const c = makeConstruction('high');
  assert.equal(c.set(site('framing', 0.4), TOP, HALF, FH), true, 'the first event builds');
  const r = c.revision;
  const st = c.structure;
  assert.equal(c.set(site('framing', 0.4), TOP, HALF, FH), false, 'the same stage and progress again is no change');
  assert.equal(c.revision, r, 'nothing is copied again');
  assert.equal(c.structure, st);
  assert.equal(c.set({ ...site('framing', 0.4), since: '2026-11-10T19:00:00.000Z' }, TOP, HALF, FH), false, 'a new timestamp alone is no change');
  assert.equal(c.set(site('framing', 0.45), TOP, HALF, FH), true, 'real progress is');
  assert.ok(c.revision > r);
  c.dispose();
});

test('the field uploads a lamp colour only when the lamp changes', () => {
  const field = makeConstructionField('high');
  const c = makeConstruction('high');
  // A site waiting on its PR: the crane parked, its lamp steady (a merged site has no crane left by now).
  c.set(site('waiting', 1), TOP, HALF, FH);
  c.update(1 / 60);
  field.update([c]);
  const lamp = field.group.getObjectByName('field:lamp') as THREE.BatchedMesh;
  let calls = 0;
  const orig = lamp.setColorAt.bind(lamp);
  lamp.setColorAt = (id: number, color: THREE.Color) => {
    calls++;
    return orig(id, color);
  };
  for (let i = 0; i < 30; i++) {
    c.update(1 / 60);
    field.update([c]);
  }
  assert.equal(calls, 0, 'a steady lamp is never re-uploaded');
  c.set(site('framing', 0.5), TOP, HALF, FH);
  for (let i = 0; i < 120; i++) {
    c.update(1 / 60);
    field.update([c]);
  }
  assert.ok(calls > 0 && calls < 120 * 2, `a flashing lamp uploads only on the frames its level changes (${calls})`);
  c.dispose();
  field.dispose();
});

test('a lit site glows warm over its deck and top floors, and the floods light the frame within the budget', () => {
  const field = makeConstructionField('high');
  const c = makeConstruction('high');
  c.set(site('framing', 0.5), TOP, HALF, FH);
  field.update([c]);
  const glare = field.group.getObjectByName('field:glare') as THREE.Mesh;
  const g = glare.geometry as THREE.InstancedBufferGeometry;
  const size = g.getAttribute('iSize') as THREE.InstancedBufferAttribute;
  let halos = 0;
  for (let i = 0; i < g.instanceCount; i++) if (size.getX(i) > HALF) halos++;
  assert.ok(halos >= 2, `a warm glow over the deck and the top floors (${halos})`);
  c.set(site('waiting', 1), TOP, HALF, FH);
  field.update([c]);
  let after = 0;
  for (let i = 0; i < g.instanceCount; i++) if (size.getX(i) > HALF) after++;
  assert.equal(after, 0, 'no glow once the floods are off');
  // The floods' beams: never brighter than the budget, and still lighting steel ten metres off.
  let peak = 0;
  for (let d = 0.5; d < 40; d += 0.25) peak = Math.max(peak, floodRadiance(d, 0.6));
  assert.ok(peak <= BLOOM_THRESHOLD + 1e-9, `lit steel never blooms (${peak.toFixed(2)})`);
  // Inverse square with a near clamp, windowed steeply past six metres: the deck and the near frame are lit, the rest stays night steel.
  assert.ok(floodRadiance(4, 0.6) > 0.15, `steel by the floods is visibly lit (${floodRadiance(4, 0.6).toFixed(2)})`);
  assert.ok(floodRadiance(10, 0.6) < 0.1 * floodRadiance(3, 0.6), `ten metres off it has fallen away (${floodRadiance(10, 0.6).toFixed(3)})`);
  assert.equal(floodRadiance(16, 0.6), 0, 'and past its window it lights nothing');
  for (let d = 3; d < 20; d += 0.5) assert.ok(floodRadiance(d + 0.5, 0.6) <= floodRadiance(d, 0.6), 'never brighter further off');
  // Warm, but not so saturated that it repaints the steel: lit primer stays red and the crane stays yellow.
  const hi = Math.max(FLOOD_TINT.r, FLOOD_TINT.g, FLOOD_TINT.b);
  const sat = (hi - Math.min(FLOOD_TINT.r, FLOOD_TINT.g, FLOOD_TINT.b)) / hi;
  const pure = new THREE.Color(FLOOD.color);
  const pureSat = (Math.max(pure.r, pure.g, pure.b) - Math.min(pure.r, pure.g, pure.b)) / Math.max(pure.r, pure.g, pure.b);
  assert.ok(sat < 0.6 && sat < pureSat * 0.7, `the flood's tint keeps the steel's own colour (saturation ${sat.toFixed(2)} against sodium ${pureSat.toFixed(2)})`);
  c.dispose();
  field.dispose();
});

test('the steel varies member by member, so the frame reads as weathered steel', () => {
  const field = makeConstructionField('high');
  const c = makeConstruction('high');
  c.set(site('framing', 0.8), TOP, HALF, FH);
  field.update([c]);
  const steel = field.group.getObjectByName('field:steel') as THREE.BatchedMesh;
  // Each member carries its own tone and wear.
  const mast = c.object.getObjectByName('construction:mast') as THREE.Mesh;
  const wear = mast.geometry.getAttribute('aWear') as THREE.BufferAttribute;
  assert.ok(wear, 'members carry a wear attribute');
  const values = new Set<string>();
  for (let i = 0; i < wear.count; i += 24) values.add(`${wear.getX(i).toFixed(3)},${wear.getY(i).toFixed(3)}`);
  assert.ok(values.size > 20, `the mast's members differ (${values.size})`);
  // The beams, one instance each, are not all one colour.
  const tones = new Set<string>();
  const col = new THREE.Color();
  for (let i = 0; i < steel.instanceCount; i++) {
    if (!steel.getVisibleAt(i)) continue;
    steel.getColorAt(i, col);
    tones.add(col.getHexString());
  }
  assert.ok(tones.size > 20, `primer tones vary beam by beam (${tones.size})`);
  c.dispose();
  field.dispose();
});

// ---------------------------------------------------------------- Task 27: inspection, the cure, teardown and the scar

/** grid.ts PLAZA_RADIUS: the district plaza's paving ends here. */
const PLAZA = 72;

/** Where a ray from `at` along `dir` first meets a box, or null. */
function rayBox(at: THREE.Vector3, dir: THREE.Vector3, box: THREE.Box3): number | null {
  const hit = new THREE.Ray(at, dir).intersectBox(box, new THREE.Vector3());
  return hit ? hit.distanceTo(at) : null;
}

test('inspecting places two searchlights at the plaza edge aimed at the floor', () => {
  const c = makeConstruction('high');
  c.set(site('framing', 0.7), TOP, HALF, FH);
  run(c, 1);
  assert.equal(c.searchlights().length, 0, 'no searchlights while the frame goes up');
  c.set(site('inspecting', 0.8), TOP, HALF, FH);
  // The crane slews to park as the frame is handed over; then only the searchlights move.
  run(c, 20);
  const lights = c.searchlights();
  assert.equal(lights.length, 2, 'two guild searchlights');
  for (const l of lights) {
    const r = Math.hypot(l.at.x, l.at.z);
    assert.ok(r > PLAZA - 16 && r < PLAZA - 2, `a searchlight stands at the plaza edge (${r.toFixed(1)} m out)`);
    assert.ok(l.at.y > 0.8 && l.at.y < 2.6, `on a tripod on the paving (${l.at.y.toFixed(2)} m up)`);
  }
  assert.ok(lights[0].at.distanceTo(lights[1].at) > 20, 'the two stand well apart, so their beams cross');
  for (const name of ['construction:searchlight-tripods', 'construction:searchlight-head-0', 'construction:searchlight-head-1']) part(c.object, name);

  // Over a minute and a half the beams sweep the new floor and never leave it: each beam ends where it meets the
  // floor's envelope (the netting hung just off its faces, up to its edge protection).
  const floor = new THREE.Box3(new THREE.Vector3(-HALF - 0.6, TOP - 0.3, -HALF - 0.6), new THREE.Vector3(HALF + 0.6, TOP + FH + 1.2, HALF + 0.6));
  const aims: Array<[THREE.Vector3, THREE.Vector3]> = [];
  let crossed = 0;
  let side: number | null = null;
  for (let t = 0; t < 90; t += 0.5) {
    assert.equal(run(c, 0.5), false, 'nothing that casts a shadow moves while they sweep');
    const [a, b] = c.searchlights();
    for (const l of [a, b]) {
      const d = rayBox(l.at, l.dir, floor);
      assert.ok(d !== null, `the beam meets the floor at ${t} s`);
      assert.ok(Math.abs(d! - l.length) < 0.05, `and ends on it (${d!.toFixed(1)} against ${l.length.toFixed(1)})`);
    }
    const pa = a.at.clone().addScaledVector(a.dir, a.length);
    const pb = b.at.clone().addScaledVector(b.dir, b.length);
    aims.push([pa, pb]);
    // Which way round the two spots lie along the face: it flips each time the beams cross.
    const s = Math.sign(new THREE.Vector3().crossVectors(pb.clone().sub(pa).setY(0), new THREE.Vector3(0, 1, 0)).dot(a.at.clone().setY(0)));
    if (side !== null && s !== 0 && s !== side) crossed++;
    if (s !== 0) side = s;
  }
  const travel = Math.max(...aims.map(([p]) => p.distanceTo(aims[0][0])));
  assert.ok(travel > HALF * 0.8, `a beam sweeps across the floor (${travel.toFixed(1)} m)`);
  assert.ok(crossed >= 2, `the sweeps cross (${crossed} crossings)`);
  // Slow: a spot moves at walking pace over the face, not a stage chase.
  let fastest = 0;
  for (let i = 1; i < aims.length; i++) fastest = Math.max(fastest, aims[i][0].distanceTo(aims[i - 1][0]) / 0.5);
  assert.ok(fastest < 4, `the sweep is slow (${fastest.toFixed(2)} m/s at most)`);

  // The beam lights the steel it falls on, within the bloom budget, falling off with the square of the distance.
  for (const d of [20, 60, 120, 300]) assert.ok(searchRadiance(d, 0.35) < BLOOM_THRESHOLD, `steel lit by a searchlight ${d} m off stays under the bloom threshold`);
  assert.ok(searchRadiance(120, 0.35) > 0.12, `the floor a searchlight falls on is visibly lit (${searchRadiance(120, 0.35).toFixed(2)})`);
  assert.ok(searchRadiance(300, 0.35) < searchRadiance(120, 0.35) * 0.25, 'and dimmer by the square of the distance');

  // The verdict ends the inspection: the lights go out.
  c.set(site('curing', 0.95), TOP, HALF, FH, { era: 'glass' });
  run(c, 0.2);
  assert.equal(c.searchlights().length, 0, 'the searchlights go out with the verdict');
  c.dispose();
});

test('curing ends with the floor\'s era material and no crane', () => {
  const c = makeConstruction('high');
  c.set(site('inspecting', 0.8), TOP, HALF, FH);
  run(c, 1);
  c.set(site('curing', 0.95), TOP, HALF, FH, { era: 'glass' });
  run(c, 1.2);
  let s = c.state()!;
  assert.ok(s.frameTint > 0 && s.frameFade === 1, 'a second in, the frame is turning from primer to the floor\'s finish');
  run(c, 1.2);
  s = c.state()!;
  assert.ok(s.frameFade > 0 && s.frameFade < 1, `then it fades into the floor (${s.frameFade.toFixed(2)})`);
  assert.ok(s.netDrop > 0, 'the netting is coming down');
  assert.equal(s.lamp, 'steady', 'the crane\'s lamp goes steady');
  assert.equal(s.floods, false, 'the floods are off');
  run(c, 2);
  s = c.state()!;
  assert.equal(s.frameFade, 0, 'after four seconds the frame has cured away');
  assert.equal(s.frameTint, 1);
  assert.equal(s.netDrop, 1);
  const f = c.finish();
  assert.ok(f && f.floor === 'era' && f.era === 'glass', `the floor finishes in its era's material (${JSON.stringify(f)})`);
  assert.equal(f!.tone.getHex(), ERA_TONE.glass.getHex(), 'the frame\'s last paint is the era\'s tone');
  const crane = part(c.object, 'construction:crane');
  const parked = constructionState(site('waiting', 1), TOP, HALF, FH).slew;
  run(c, 20);
  assert.ok(Math.abs(part(c.object, 'construction:slew').rotation.y - parked) < 1e-3, 'the crane has slewed to park');
  assert.equal(c.finish()!.windows, null, 'a shipped floor is not lit yet');

  // Waiting on his review: the floor stays dark and the parked crane stays.
  c.set(site('waiting', 1), TOP, HALF, FH, { era: 'glass' });
  assert.equal(run(c, 60), false, 'a waiting site holds still');
  assert.ok(crane.parent, 'the crane stays parked while the PR waits');
  assert.equal(c.finish()!.windows, null, 'its windows stay dark');

  // Merged: the windows light row by row, then the crane comes down.
  c.set(site('curing', 1), TOP, HALF, FH, { era: 'glass' });
  const lit: number[] = [];
  for (let i = 0; i < 8; i++) {
    run(c, 0.5);
    lit.push(c.finish()!.windows ?? -1);
  }
  assert.ok(lit[0] > 0 && lit[0] < 1, `the windows begin to light (${lit[0]})`);
  for (let i = 1; i < lit.length; i++) assert.ok(lit[i] >= lit[i - 1], 'row by row, never going dark again');
  assert.ok(lit.at(-1) === 1, 'until every row is lit');
  run(c, 8);
  assert.equal(c.object.getObjectByName('construction:crane'), undefined, 'no crane is left');
  assert.equal(c.state()?.crane ?? null, null);
  assert.equal(c.finish()!.floor, 'era', 'the floor stays in its era\'s material');
  assert.equal(c.finish()!.windows, 1, 'and lit');
  assert.equal(run(c, 30), false, 'then nothing moves');
  c.dispose();
});

test('scar ends with a primer floor and a work lamp', () => {
  const c = makeConstruction('high');
  c.set(site('inspecting', 0.8), TOP, HALF, FH);
  run(c, 1);
  const beams = part<THREE.InstancedMesh>(c.object, 'construction:beams');
  const total = beams.count;
  c.set(site('scar', 1), TOP, HALF, FH, { era: 'brick' });
  run(c, 2);
  let s = c.state()!;
  assert.ok(s.netDrop > 0.9, 'the netting drops first');
  assert.ok(s.strike > 0 && s.strike < 1, 'the skeleton is coming down');
  assert.ok(s.crane, 'the crane is still up, lowering steel');
  assert.equal(c.workLamp(), null, 'no work lamp while the crew strikes the site');
  const fades = beams.userData.fade as Float32Array;
  assert.ok(fades && fades.length >= total, 'each beam fades on its own');
  run(c, 4.5);
  s = c.state()!;
  assert.equal(s.strike, 1, 'after six seconds the skeleton is down');
  assert.equal(s.dismantle, 1, 'and the crane dismantled');
  assert.equal(c.object.getObjectByName('construction:crane'), undefined, 'no crane is left');
  assert.equal(c.object.getObjectByName('construction:beams'), undefined, 'no frame is left');
  const f = c.finish();
  assert.ok(f && f.floor === 'primer', `the site ends on the primer floor (${JSON.stringify(f)})`);
  const lamp = c.workLamp();
  assert.ok(lamp, 'a single work lamp is left burning');
  assert.ok(lamp!.at.y > TOP + 0.5 && lamp!.at.y < TOP + FH, `on the scar floor (${lamp!.at.y.toFixed(2)} m)`);
  assert.ok(Math.max(Math.abs(lamp!.at.x), Math.abs(lamp!.at.z)) < HALF + 1.2 && Math.min(Math.abs(lamp!.at.x), Math.abs(lamp!.at.z)) > HALF - 1.5, 'clamped at a bare corner');
  assert.ok(lamp!.intensity > 0 && workLampRadiance(1, 0.3) < BLOOM_THRESHOLD, 'burning, within the bloom budget a metre off');
  assert.equal(run(c, 3600), false, 'nothing moves for the rest of the evening');
  assert.ok(c.workLamp(), 'and the lamp still burns an hour on');
  c.dispose();

  // A run that came down without a recorded attempt leaves nothing at all.
  const t = makeConstruction('high');
  t.set(site('framing', 0.6), TOP, HALF, FH);
  run(t, 1);
  t.set(site('teardown', 1), TOP, HALF, FH);
  run(t, 7);
  assert.equal(t.object.children.length, 0, 'teardown leaves no floor, no crane and no lamp');
  assert.equal(t.workLamp(), null);
  assert.equal(t.finish()?.floor ?? null, null);
  t.dispose();
});

test('a scar first seen by a fresh construction (the quality drop rebuilds every site) stands its work lamp without a crane', () => {
  // The city's step down to medium makes every site's construction anew and sets it straight to the site's stage: a
  // scar has a work lamp and no crane, and must build from nothing without reading a crane that is not there.
  for (const quality of ['medium', 'high'] as const) {
    const c = makeConstruction(quality);
    assert.doesNotThrow(() => c.set(site('scar', 1), TOP, HALF, FH), `${quality}: a fresh scar builds`);
    run(c, 1);
    const s = c.state()!;
    assert.equal(s.crane, null, 'no crane stands on a scar');
    assert.ok(s.workLamp, 'its work lamp burns');
    c.dispose();
  }
});
