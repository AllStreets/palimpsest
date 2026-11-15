import './kit-setup.js';
import assert from 'node:assert/strict';
import { statSync } from 'node:fs';
import { test } from 'node:test';
import * as THREE from 'three';

import { hasKit, kitShared } from '../app/src/city/kits.js';
import { codedParts, interiorOf, modelParts, nearPart } from '../app/src/city/vehicles.js';

// The train's cab car and the cab, modelled in the kit pipeline (tools/kits/kits.py), read from kits.glb in Node.

const PIECES = ['veh_railEnd', 'veh_railEnd_gear', 'veh_cab', 'veh_cab_gear'];

test('kits.glb carries the modelled vehicles and leaves headroom under its cap', () => {
  for (const p of PIECES) assert.ok(hasKit(p), `kit piece ${p}`);
  const size = statSync(new URL('../app/public/kits/kits.glb', import.meta.url)).size;
  assert.ok(size <= 850_000, `kits.glb is ${(size / 1000).toFixed(0)} KB (at most 850 KB, leaving room for the figures)`);
});

test('every coded face of the modelled vehicles maps to a part, nothing is dropped', () => {
  for (const p of PIECES) {
    const parts = codedParts(kitShared(p));
    assert.equal(parts.unknown, 0, `${p}: every face's code is known`);
    assert.ok(parts.total > 100, `${p}: ${parts.total} triangles`);
  }
  const shell = codedParts(kitShared('veh_railEnd'));
  assert.ok(shell.parts.body > 0 && shell.parts.glass > 0 && shell.parts.trim > 0, 'the train shell has body, glazing and running gear');
  const gear = codedParts(kitShared('veh_railEnd_gear'));
  assert.ok(gear.kinds.board > 0 && gear.kinds.head > 0 && gear.kinds.tail > 0, 'its lamps: head, tail and the destination board');
  const cab = codedParts(kitShared('veh_cab'));
  assert.ok(cab.parts.body > 0 && cab.parts.glass > 0, 'the cab has body and canopy');
});

test('with the kits loaded the near train cab car and the cab are the modelled meshes', () => {
  const rail = modelParts('railEnd');
  const cab = modelParts('cab');
  assert.ok(rail.lamp > 0 && rail.glass > 0 && rail.body > 1000, `the cab car draws the modelled shell (${JSON.stringify(rail)})`);
  assert.ok(cab.body > 500, `the cab draws the modelled body (${JSON.stringify(cab)})`);
});

// ---------------------------------------------------------------- the destination board's dot-matrix face

import { LED_DESTINATIONS, ledColumns, ledGlyph } from '../app/src/city/vehicles.js';

/** The 5 by 7 letters as they must read (top row first, # lit), written out here apart from the shader's table. */
const EXPECTED: Record<string, string[]> = {
  N: ['#...#', '##..#', '#.#.#', '#..##', '#...#', '#...#', '#...#'],
  O: ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  R: ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
  T: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
  H: ['#...#', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  G: ['.###.', '#...#', '#....', '#.###', '#...#', '#...#', '.####'],
  A: ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  E: ['#####', '#....', '#....', '####.', '#....', '#....', '#####'],
};

test("the board's font draws each letter of every destination as it must read", () => {
  const used = new Set<string>(LED_DESTINATIONS.join('').replace(/[^A-Z]/g, '').split(''));
  for (const ch of used) {
    const rows = ledGlyph(ch);
    assert.equal(rows.length, 7, `${ch} has seven rows`);
    for (const r of rows) assert.match(r, /^[.#]{5}$/, `${ch} rows are five dots`);
    if (EXPECTED[ch]) assert.deepEqual(rows, EXPECTED[ch], `${ch} reads as ${ch}`);
  }
  for (const ch of 'NORTHGATE') assert.ok(EXPECTED[ch], `the expected table covers ${ch}`);
});

test("a destination renders into the board's columns whole, unclipped, each letter where it belongs", () => {
  for (const name of LED_DESTINATIONS) {
    const { columns, start, width } = ledColumns(name);
    assert.ok(start >= 1 && start + width <= columns.length - 1, `${name} fits the board with a dark column each side (${start}+${width} of ${columns.length})`);
    [...name].forEach((ch, i) => {
      const rows = EXPECTED[ch] ?? ledGlyph(ch);
      for (let col = 0; col < 5; col++) {
        for (let row = 0; row < 7; row++) {
          const lit = (columns[start + i * 6 + col] >> row) & 1;
          assert.equal(lit, rows[row][col] === '#' ? 1 : 0, `${name}: ${ch} column ${col} row ${row}`);
        }
      }
      if (i < name.length - 1) assert.equal(columns[start + i * 6 + 5], 0, `a dark column after ${ch}`);
    });
  }
});

// ---------------------------------------------------------------- inside the cars

/** The near model's solid parts (body, trim, lamps) as one mesh drawn front faces only, as the app draws them. */
function solid(name: Parameters<typeof nearPart>[0]): THREE.Mesh {
  const geos = (['body', 'trim', 'lamp'] as const).map((p) => nearPart(name, p)).filter((g): g is THREE.BufferGeometry => !!g);
  const pos: number[] = [];
  for (const g of geos) pos.push(...(g.attributes.position.array as Float32Array));
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return new THREE.Mesh(g, new THREE.MeshBasicMaterial({ side: THREE.FrontSide }));
}

test('from a seat inside a car the cabin is closed round the rider: floor, ceiling, the walls under the sills and over the window heads', () => {
  for (const name of ['railEnd', 'railMid', 'tram', 'pod', 'ferry', 'cab'] as const) {
    const i = interiorOf(name);
    const mesh = solid(name);
    const ray = new THREE.Raycaster();
    const eye = new THREE.Vector3((i.min[0] + i.max[0]) / 2 + 0.3, i.min[1] + Math.min(1.2, (i.max[1] - i.min[1]) * 0.6), 0.2);
    const hits = (dir: THREE.Vector3): boolean => {
      ray.set(eye, dir.normalize());
      ray.far = 12;
      return ray.intersectObject(mesh).length > 0;
    };
    assert.ok(hits(new THREE.Vector3(0, -1, 0)), `${name}: a floor under the rider`);
    assert.ok(hits(new THREE.Vector3(0, 1, 0)), `${name}: a ceiling over the rider`);
    const low = i.min[1] + (i.sill - i.min[1]) * 0.5 - eye.y;
    for (const side of [-1, 1]) assert.ok(hits(new THREE.Vector3(0, low, side * (i.max[2] - eye.z * side))), `${name}: the wall under the ${side < 0 ? 'left' : 'right'} sill`);
    if (i.head < i.max[1] - 0.05) assert.ok(hits(new THREE.Vector3(0, i.head + (i.max[1] - i.head) / 2 - eye.y, i.max[2] - eye.z)), `${name}: the wall over the window head`);
    assert.ok(hits(new THREE.Vector3(1, -0.05, 0)) && hits(new THREE.Vector3(-1, -0.05, 0)), `${name}: an end wall ahead and behind`);
  }
});

test('a seat stands where a rider sits, in the cars people sit in', () => {
  for (const [name, along, across, height] of [['railMid', 0, 0.6, 0.45], ['ferry', 0.5, 1.2, 0.45], ['cab', -0.45, 0.38, 0.14]] as const) {
    const i = interiorOf(name);
    const mesh = solid(name);
    const ray = new THREE.Raycaster(new THREE.Vector3(along, i.min[1] + height + 0.3, across), new THREE.Vector3(0, -1, 0));
    const hit = ray.intersectObject(mesh)[0];
    assert.ok(hit, `${name}: something under the rider`);
    const top = hit.point.y - i.min[1];
    assert.ok(Math.abs(top - height) < 0.08, `${name}: the seat's top stands ${top.toFixed(2)} m over the floor (the rider sits at ${height})`);
  }
});

// ---------------------------------------------------------------- up close (Phase 5 Task 5)

import { extentBlocks, network } from '../shared/commute.js';
import { districtOrigin } from '../shared/district-layout.js';
import { createVehicles, lodBlend, podVariant, VEHICLE_LOD } from '../app/src/city/vehicles.js';

test('two pods side by side differ in seats or strip', () => {
  const slots = Array.from({ length: 11 }, (_, i) => districtOrigin(i));
  const v = createVehicles(network({ blocks: extentBlocks(slots), districts: slots.slice(0, 6) }), 'high');
  const pods = v.vehicles('pod');
  assert.ok(pods.length >= 4, `${pods.length} pods`);
  // The pods of one line in the order they follow each other: each against the next, and the last against the first.
  const lines = new Map<string, string[]>();
  for (const p of pods) {
    const line = p.id.slice(0, p.id.lastIndexOf(':'));
    lines.set(line, [...(lines.get(line) ?? []), p.id]);
  }
  let pairs = 0;
  for (const ids of lines.values()) {
    ids.sort((a, b) => Number(a.slice(a.lastIndexOf(':') + 1)) - Number(b.slice(b.lastIndexOf(':') + 1)));
    for (let k = 0; k < ids.length; k++) {
      const a = podVariant(ids[k]);
      const b = podVariant(ids[(k + 1) % ids.length]);
      if (ids.length < 2) continue;
      pairs++;
      assert.ok(a.seat !== b.seat || a.strip !== b.strip, `${ids[k]} and ${ids[(k + 1) % ids.length]} are the same inside (${JSON.stringify(a)})`);
      for (const x of [a, b]) {
        assert.ok(x.seat === 0 || x.seat === 1, 'two seat colourways');
        assert.ok(x.strip === 0 || x.strip === 1, 'two ceiling strips');
      }
    }
  }
  assert.ok(pairs >= 4, `${pairs} pairs compared`);
  v.dispose();
});

test('the cross-fade keeps summed opacity within 0.95 to 1.05 across 380 to 420 m', () => {
  assert.equal((VEHICLE_LOD.near + VEHICLE_LOD.far) / 2, 400, 'the band is centred on 400 m');
  for (let d = 380; d <= 420; d += 0.5) {
    const b = lodBlend(d);
    assert.ok(b.near >= 0 && b.near <= 1 && b.far >= 0 && b.far <= 1, `at ${d} m the levels' shares are shares`);
    assert.ok(b.near + b.far >= 0.95 && b.near + b.far <= 1.05, `at ${d} m the levels sum to ${(b.near + b.far).toFixed(3)}`);
  }
  // Short of the band the near level alone; past it the far level alone; the middle an even split.
  assert.deepEqual(lodBlend(VEHICLE_LOD.near - 1), { near: 1, far: 0 });
  assert.deepEqual(lodBlend(VEHICLE_LOD.far + 1), { near: 0, far: 1 });
  assert.ok(Math.abs(lodBlend(400).near - 0.5) < 1e-6);
});
