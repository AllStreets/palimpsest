import assert from 'node:assert/strict';
import { test } from 'node:test';

import * as THREE from 'three';

import { constructionState, makeConstruction, makeConstructionField, makeHoist, netPanel, netTextures } from '../app/src/city/construction.js';
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
