import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AMBIENT_RENDERED } from '../app/src/city/ambient-rendered.js';
import { ambientCap, ROOF_CLUTTER, type CollarPlaza } from '../app/src/city/collar.js';
import {
  ARCHETYPES,
  blockLots,
  farLot,
  lotParts,
  makeBlock,
  neighbourhood,
  PITCH,
  RING_REACH,
  RING_VALUE,
  standingLots,
  TONES,
  type Archetype,
  type Hood,
  type Lab,
  type Lot,
} from '../app/src/city/lots.js';
import { RENDERED } from '../app/src/city/tower/rendered.js';
import { SEPARATION, VARIANTS } from '../app/src/city/tower/variants.js';
import { districtOrigin } from '../shared/district-layout.js';
import { ROOT_HEIGHT } from '../shared/tower-layout.js';

const R = 22;
const CIVIC: CollarPlaza = { x: 0, z: 0 };
const blocks = (): Array<[number, number]> => {
  const out: Array<[number, number]> = [];
  for (let i = -R; i <= R; i++) for (let j = -R; j <= R; j++) out.push([i, j]);
  return out;
};
const CITY = blocks().flatMap(([i, j]) => standingLots(i, j, [CIVIC]));

function touching(a: Lot, b: Lot): boolean {
  const gx = Math.abs(a.x - b.x) - (a.w + b.w) / 2;
  const gz = Math.abs(a.z - b.z) - (a.d + b.d) / 2;
  return gx < 0.6 && gz < 0.6;
}

const dE = (a: Lab, b: Lab): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** A district with the stone and brick variants of a real tower look, as the scene hands it to the grid. */
function district(slot: number, root: number, ids: string[]): CollarPlaza {
  const o = districtOrigin(slot);
  const tones: Lab[] = [];
  for (const id of ids) for (const k of ['sun', 'sunLow'] as const) if (RENDERED[id]?.[k]) tones.push(RENDERED[id][k]!);
  // The value step is taken from the tower's lowest era, the stone floors that stand right over the root.
  return { ...o, rootHeight: root, tones, value: ids.length ? RENDERED[ids[0]]?.sun[0] : undefined };
}

test('a block always rebuilds the same lots, whatever was built before it', () => {
  const first = makeBlock(5, -3);
  for (const [i, j] of blocks().slice(0, 300)) makeBlock(i, j);
  assert.deepEqual(makeBlock(5, -3), first);
  for (const [i, j] of blocks()) assert.deepEqual(makeBlock(i, j), blockLots(i, j), `block ${i},${j}`);
  assert.deepEqual(farLot(31, -12), farLot(31, -12));
});

test('the city mixes at least six building types, each with its own share', () => {
  const n = new Map<Archetype, number>();
  for (const l of CITY) n.set(l.archetype, (n.get(l.archetype) ?? 0) + 1);
  assert.ok(ARCHETYPES.length >= 6);
  for (const a of ARCHETYPES) assert.ok((n.get(a) ?? 0) / CITY.length >= 0.03, `${a}: ${n.get(a) ?? 0} of ${CITY.length}`);
});

test('neighbourhoods drift in character: an older masonry core, a glassier spine, an industrial edge', () => {
  const by = new Map<Hood, Lot[]>();
  for (const l of CITY) by.set(l.hood, [...(by.get(l.hood) ?? []), l]);
  const share = (h: Hood, as: Archetype[]): number => {
    const lots = by.get(h) ?? [];
    return lots.filter((l) => as.includes(l.archetype)).length / Math.max(1, lots.length);
  };
  assert.ok(share('core', ['walkup', 'commercial']) >= 0.55, `core masonry ${share('core', ['walkup', 'commercial'])}`);
  assert.ok(share('spine', ['glass', 'midcentury']) >= 0.45, `spine glass ${share('spine', ['glass', 'midcentury'])}`);
  assert.ok(share('industrial', ['industrial']) >= 0.45, `industrial ${share('industrial', ['industrial'])}`);
  assert.ok(share('residential', ['walkup']) >= 0.4, `residential walkups ${share('residential', ['walkup'])}`);
  assert.ok(share('midtown', ['midcentury', 'brutalist', 'parking']) >= 0.35, `midtown ${share('midtown', ['midcentury', 'brutalist', 'parking'])}`);
  for (const [h, lots] of by) {
    assert.ok(new Set(lots.map((l) => l.archetype)).size >= 4, `${h} mixes types`);
  }
  // Every character is a neighbourhood, not a speck: each holds a fair share of the blocks.
  const hoods = new Map<Hood, number>();
  for (const [i, j] of blocks()) hoods.set(neighbourhood(i, j), (hoods.get(neighbourhood(i, j)) ?? 0) + 1);
  for (const h of ['core', 'spine', 'midtown', 'residential', 'industrial'] as Hood[]) assert.ok((hoods.get(h) ?? 0) / blocks().length >= 0.05, `${h}: ${hoods.get(h)}`);
  // Drift, not noise: most blocks share their character with most of their four neighbours.
  let same = 0;
  for (const [i, j] of blocks()) {
    const h = neighbourhood(i, j);
    const k = [neighbourhood(i + 1, j), neighbourhood(i - 1, j), neighbourhood(i, j + 1), neighbourhood(i, j - 1)].filter((x) => x === h).length;
    if (k >= 3) same++;
  }
  assert.ok(same / blocks().length > 0.6, `coherent ${same / blocks().length}`);
});

test('no two touching lots share both their type and their colour', () => {
  const look = [VARIANTS.stone[0].id, VARIANTS.brick[0].id];
  for (const plazas of [[CIVIC], [CIVIC, district(0, 30, look), district(3, 26, look)]]) {
    for (const [i, j] of blocks()) {
      const lots = standingLots(i, j, plazas);
      for (let a = 0; a < lots.length; a++) {
        for (let b = a + 1; b < lots.length; b++) {
          if (!touching(lots[a], lots[b])) continue;
          assert.ok(!(lots[a].archetype === lots[b].archetype && lots[a].tone === lots[b].tone), `block ${i},${j}: two ${lots[a].archetype} in ${lots[a].tone}`);
        }
      }
    }
  }
});

test('a freed plot refills with exactly the blocks that stood before the district came', () => {
  const look = [VARIANTS.stone[1].id, VARIANTS.brick[2].id];
  const with4 = [CIVIC, district(0, 26, look), district(4, 34, look)];
  const without = [CIVIC, district(0, 26, look)];
  const o = districtOrigin(4);
  const ci = Math.round(o.x / PITCH);
  const cj = Math.round(o.z / PITCH);
  for (let i = ci - 5; i <= ci + 5; i++) {
    for (let j = cj - 5; j <= cj + 5; j++) {
      const before = standingLots(i, j, without);
      standingLots(i, j, with4);
      assert.deepEqual(standingLots(i, j, without), before, `block ${i},${j}`);
    }
  }
});

test('every type, walls and roofs, stays under the collar round a district', () => {
  const seen = new Set<Archetype>();
  for (const root of Object.values(ROOT_HEIGHT)) {
    const plazas = [CIVIC, district(0, root, []), district(5, root, [])];
    for (const [i, j] of blocks()) {
      for (const lot of standingLots(i, j, plazas)) {
        const cap = ambientCap(lot.x, lot.z, plazas);
        if (cap === Infinity) continue;
        seen.add(lot.archetype);
        assert.ok(lot.h <= cap + 1e-6, `${lot.archetype} wall ${lot.h} over cap ${cap}`);
        for (const p of lotParts(lot)) {
          const top = p.y + p.sy / 2;
          assert.ok(top <= cap + ROOF_CLUTTER + 1e-6, `${lot.archetype} ${p.kind} top ${top.toFixed(2)} over ${(cap + ROOF_CLUTTER).toFixed(2)}`);
        }
      }
    }
  }
  for (const a of ARCHETYPES) assert.ok(seen.has(a), `${a} was tested under a cap`);
});

test('roof clutter never rises more than the collar allows over any roof', () => {
  for (const lot of CITY) {
    const cap = ambientCap(lot.x, lot.z, [CIVIC]);
    for (const p of lotParts(lot)) {
      const top = p.y + p.sy / 2;
      if (p.kind === 'chimney') assert.ok(top <= cap + ROOF_CLUTTER + 1e-6, 'a stack only where nothing caps it');
      else assert.ok(top <= lot.h + ROOF_CLUTTER + 1e-6, `${lot.archetype} ${p.kind} ${top - lot.h} m over its roof`);
    }
  }
});

/**
 * A rendered colour's family: hue by value. The dusk key light warms every
 * face in the scene (the towers' stones render at hue 36 to 50 degrees), so
 * hue is read against it: cool below 33 degrees (the blue and grey-green
 * the sky and glass lend), warm from 42 (amber, buff, red), neutral between
 * or when nearly grey.
 */
function family(lab: Lab): string {
  const [L, a, b] = lab;
  const c = Math.hypot(a, b);
  const h = (Math.atan2(b, a) * 180) / Math.PI;
  const hue = c < 9 || (h >= 33 && h < 42) ? 'neutral' : h < 33 ? 'cool' : 'warm';
  const value = L < 37 ? 'dark' : L < 45 ? 'mid' : 'light';
  return `${hue}-${value}`;
}

test('every tone is measured in the real scene light', () => {
  for (const a of ARCHETYPES) for (const t of TONES[a]) assert.ok(AMBIENT_RENDERED[t.id], `${t.id} has no rendered colour`);
});

test('the ambient city renders across cool and warm, light and dark, never one brown', () => {
  const labs = CITY.map((l) => AMBIENT_RENDERED[l.tone]?.sun).filter((v): v is Lab => !!v);
  assert.equal(labs.length, CITY.length);
  const Ls = labs.map((v) => v[0]).sort((a, b) => a - b);
  const spread = Ls[Math.floor(Ls.length * 0.9)] - Ls[Math.floor(Ls.length * 0.1)];
  assert.ok(spread >= 16, `value spread ${spread}`);
  const fam = new Map<string, number>();
  for (const v of labs) fam.set(family(v), (fam.get(family(v)) ?? 0) + 1);
  const shares = [...fam].map(([f, n]) => [f, n / labs.length] as const).sort((a, b) => b[1] - a[1]);
  assert.ok(shares[0][1] <= 0.3, `largest family ${shares[0][0]} ${shares[0][1].toFixed(2)}`);
  assert.ok(shares.filter(([, s]) => s >= 0.04).length >= 6, `families ${JSON.stringify(shares)}`);
  const hue = (h: string): number => shares.filter(([f]) => f.startsWith(h)).reduce((s, [, v]) => s + v, 0);
  assert.ok(hue('cool') >= 0.15, `cool ${hue('cool')}`);
  assert.ok(hue('warm') >= 0.15 && hue('warm') <= 0.6, `warm ${hue('warm')}`);
  // Brown: a mid or dark warm colour of real chroma, the one colour the old city was built in.
  const brown = labs.filter(([L, a, b]) => L < 48 && Math.hypot(a, b) >= 13 && (Math.atan2(b, a) * 180) / Math.PI >= 38).length / labs.length;
  assert.ok(brown <= 0.3, `brown ${brown}`);
});

test('at a plaza edge the ambient blocks keep clear of the tower colours and a value step from them', () => {
  for (const stone of VARIANTS.stone) {
    for (const brick of VARIANTS.brick) {
      const d = district(1, 30, [stone.id, brick.id]);
      const plazas = [CIVIC, d];
      const ci = Math.round(d.x / PITCH);
      const cj = Math.round(d.z / PITCH);
      for (let i = ci - 3; i <= ci + 3; i++) {
        for (let j = cj - 3; j <= cj + 3; j++) {
          for (const lot of standingLots(i, j, plazas)) {
            if (Math.hypot(lot.x - d.x, lot.z - d.z) > RING_REACH) continue;
            const mine = AMBIENT_RENDERED[lot.tone];
            for (const t of d.tones ?? []) assert.ok(dE(mine.sun, t) >= SEPARATION, `${lot.tone} beside ${stone.id}/${brick.id}: dE ${dE(mine.sun, t).toFixed(1)}`);
            assert.ok(Math.abs(mine.sun[0] - d.value!) >= RING_VALUE, `${lot.tone} beside ${stone.id}: dL ${(mine.sun[0] - d.value!).toFixed(1)}`);
          }
        }
      }
    }
  }
});

test("a tower's look changing retones only the blocks in its ring; every block outside it stays as it was", () => {
  // The same district, its tower restyled from one stone and brick to another (a restyle, or the picker moving it).
  const before = district(1, 30, [VARIANTS.stone[0].id, VARIANTS.brick[0].id]);
  const after = district(1, 30, [VARIANTS.stone[VARIANTS.stone.length - 1].id, VARIANTS.brick[VARIANTS.brick.length - 1].id]);
  const ci = Math.round(before.x / PITCH);
  const cj = Math.round(before.z / PITCH);
  let retoned = 0;
  let outside = 0;
  for (let i = ci - 6; i <= ci + 6; i++) {
    for (let j = cj - 6; j <= cj + 6; j++) {
      const a = standingLots(i, j, [CIVIC, before]);
      const b = standingLots(i, j, [CIVIC, after]);
      const inRing = a.some((l) => Math.hypot(l.x - before.x, l.z - before.z) <= RING_REACH);
      if (!inRing) {
        outside++;
        assert.deepEqual(b, a, `block ${i},${j} lies outside the ring and must not change`);
        continue;
      }
      assert.equal(b.length, a.length, `block ${i},${j} keeps its lots`);
      for (let k = 0; k < a.length; k++) {
        const near = Math.hypot(a[k].x - before.x, a[k].z - before.z) <= RING_REACH;
        if (a[k].tone !== b[k].tone || a[k].archetype !== b[k].archetype) retoned++;
        // Out of the ring a lot keeps its footprint and type; only a retoned neighbour can move its tone.
        if (!near) assert.equal(b[k].archetype, a[k].archetype, `block ${i},${j} lot ${k} out of the ring keeps its type`);
        assert.deepEqual([b[k].x, b[k].z, b[k].w, b[k].d], [a[k].x, a[k].z, a[k].w, a[k].d]);
      }
    }
  }
  assert.ok(outside > 100, `blocks outside the ring checked: ${outside}`);
  assert.ok(retoned > 0, 'a different tower look retones some lots in its ring');
});

// ---------------------------------------------------------------- ambient traffic and crowds (Task 32)

import { readFileSync } from 'node:fs';
import { extentBlocks, inChannel, network, streetLine } from '../shared/commute.js';
import { ambientDensity, ambientModels, createAmbient, AMBIENT_CAP, type Ambient } from '../app/src/city/ambient.js';

/** The sample city's network, as the commute and vehicle tests lay it. */
const SLOTS = Array.from({ length: 11 }, (_, i) => districtOrigin(i));
const NET = network({ blocks: extentBlocks(SLOTS), districts: SLOTS.slice(0, 6) });
const PLAZAS = [{ x: 0, z: 0 }, ...SLOTS.slice(0, 6)];

/** Runs the ambient clock on in steps, calling `each` after every one. */
function run(a: Ambient, seconds: number, step: number, each: (t: number) => void = () => {}): void {
  for (let t = 0; t < seconds; t += step) {
    a.update(step);
    each(t);
  }
}

test('ambient vehicles never leave the street grid', () => {
  const a = createAmbient(NET, 'high', { seed: 7 });
  a.setDensity(1);
  const cars0 = a.cars();
  assert.ok(cars0.length > 200, `a city's worth of traffic (${cars0.length})`);
  let stopped = 0;
  let moving = 0;
  let turning = 0;
  /** Junctions by key: which axes' traffic stood in the box at once. */
  let clash = '';
  run(a, 240, 0.1, (t) => {
    const inBox = new Map<string, Set<string>>();
    for (const c of a.cars()) {
      const dx = Math.abs(c.x - streetLine(c.x));
      const dz = Math.abs(c.z - streetLine(c.z));
      // On a carriageway: within 4 m of a street's centre line (its two 4 m lanes), or in a junction's box.
      assert.ok(Math.min(dx, dz) <= 4.05, `car ${c.id} on the carriageway at ${c.x.toFixed(1)}, ${c.z.toFixed(1)} (t ${t.toFixed(1)})`);
      assert.ok(!inChannel(c.x, 1), `car ${c.id} off the river at ${c.x.toFixed(1)}`);
      for (const p of PLAZAS) assert.ok(Math.hypot(c.x - p.x, c.z - p.z) > 72, `car ${c.id} outside the plaza at ${p.x}, ${p.z}`);
      if (c.speed < 0.05) stopped++;
      else moving++;
      if (c.junction) {
        if (c.turn !== 'straight') turning++;
        const s = inBox.get(c.junction) ?? new Set<string>();
        s.add(c.axis);
        inBox.set(c.junction, s);
      }
    }
    for (const [k, s] of inBox) if (s.size > 1 && !clash) clash = `${k} at ${t.toFixed(1)}`;
  });
  assert.ok(stopped > 0 && moving > stopped, `traffic moves and queues (${moving} moving, ${stopped} standing)`);
  assert.ok(turning > 0, 'cars turn at junctions');
  assert.equal(clash, '', 'a junction passes one axis at a time (in turn)');
  // Cars keep their distance: nobody stands closer than a metre behind the car ahead in its lane.
  const byLane = new Map<string, Array<{ s: number; len: number }>>();
  for (const c of a.cars()) {
    const l = byLane.get(c.lane) ?? [];
    l.push({ s: c.s, len: c.length });
    byLane.set(c.lane, l);
  }
  for (const [lane, cars] of byLane) {
    cars.sort((p, q) => p.s - q.s);
    for (let i = 1; i < cars.length; i++) assert.ok(cars[i].s - cars[i].len - cars[i - 1].s > 1, `gap on ${lane}: ${(cars[i].s - cars[i].len - cars[i - 1].s).toFixed(2)}`);
  }
  a.dispose();
});

test('density follows the quality setting', () => {
  const high = createAmbient(NET, 'high', { seed: 3 });
  const medium = createAmbient(NET, 'medium', { seed: 3 });
  high.setDensity(1);
  medium.setDensity(1);
  const h = { cars: high.cars().length, people: high.people().length };
  const m = { cars: medium.cars().length, people: medium.people().length };
  assert.ok(h.cars <= AMBIENT_CAP.high.cars && h.people <= AMBIENT_CAP.high.people, `high stays within its cap (${h.cars}, ${h.people})`);
  assert.ok(m.cars <= AMBIENT_CAP.medium.cars && m.people <= AMBIENT_CAP.medium.people, `medium stays within its cap (${m.cars}, ${m.people})`);
  assert.ok(h.cars > m.cars * 1.6 && h.people > m.people * 1.6, `high fills the streets fuller than medium (${h.cars}/${m.cars} cars, ${h.people}/${m.people} people)`);
  // The governor's step down reaches it at once, and does not throw.
  high.setQuality('medium');
  assert.equal(high.cars().length, m.cars);
  assert.equal(high.people().length, m.people);
  high.update(0.1);
  // Density scales the population; none at all leaves the streets empty.
  medium.setDensity(0.5);
  assert.ok(Math.abs(medium.cars().length - m.cars / 2) <= 1 && Math.abs(medium.people().length - m.people / 2) <= 1, 'half the density, half the population');
  // By the hour (scene.ts) the change drifts in a car and a person at a time, never all at once.
  medium.setDensity(1);
  const full = medium.cars().length;
  medium.setDensity(0.5, true);
  medium.update(0.5);
  const after = medium.cars().length;
  assert.ok(after < full && after > full * 0.8, `the drift is gradual (${full} to ${after})`);
  medium.setDensity(0);
  medium.update(0.1);
  assert.equal(medium.cars().length + medium.people().length, 0);
  // The time of day: the small hours are quiet, the evening rush is full.
  assert.ok(ambientDensity(3.5) < 0.3, `3:30 am is quiet (${ambientDensity(3.5)})`);
  assert.ok(ambientDensity(18) > 0.9 && ambientDensity(8.5) > 0.85, 'the rush hours are busy');
  for (let hr = 0; hr < 24; hr += 0.25) assert.ok(ambientDensity(hr) > 0 && ambientDensity(hr) <= 1, `${hr}`);
  high.dispose();
  medium.dispose();
});

test('no ambient object carries a plate', () => {
  const a = createAmbient(NET, 'high', { seed: 5 });
  a.setDensity(1);
  a.update(0.5);
  a.group.traverse((o) => {
    assert.ok(!/plate|label|persona|trip/i.test(o.name), `${o.name} is unlabelled`);
    assert.equal(o.userData.plate, undefined, `${o.name} carries no plate`);
    assert.equal(o.userData.pick, undefined, `${o.name} is not pickable`);
  });
  // Its cabs carry no roof light: every lamp on every model sits well under its roof, and none shows a light of its own.
  for (const [name, m] of Object.entries(ambientModels())) {
    assert.ok(m.lampTop < m.roof - 0.03, `${name}: lamps under the roof (${m.lampTop.toFixed(2)} against ${m.roof.toFixed(2)})`);
    assert.equal(m.ownLights, 0, `${name}: no lamp of its own colour (a roof sign)`);
  }
  assert.ok(a.cars().some((c) => c.model === 'cab'), 'ambient cabs run');
  // Ambient code never imports trips, the plates, or the persona vehicles.
  const src = readFileSync(new URL('../app/src/city/ambient.ts', import.meta.url), 'utf8');
  const imports = src.split('\n').filter((l) => /^import /.test(l)).join('\n');
  assert.doesNotMatch(imports, /Trip|trips|labels|vehicles|people/);
  a.dispose();
});

test('pedestrians keep to the pavements, plazas, stops and crossings', () => {
  const a = createAmbient(NET, 'high', { seed: 11 });
  a.setDensity(1);
  const states = new Set<string>();
  run(a, 120, 0.1, () => {
    for (const p of a.people()) {
      states.add(p.state);
      const dx = Math.abs(p.x - streetLine(p.x));
      const dz = Math.abs(p.z - streetLine(p.z));
      const inPlaza = PLAZAS.some((q) => Math.hypot(p.x - q.x, p.z - q.z) < 70);
      const onRoad = (dz < 4 && dx > 8) || (dx < 4 && dz > 8);
      // A tram platform stands in the street's kerb lane, from 3.45 m out.
      const onPlatform = p.state === 'waiting' && Math.min(dx, dz) >= 3.5;
      assert.ok(inPlaza || !onRoad || onPlatform, `${p.id} (${p.state}) off the carriageway at ${p.x.toFixed(1)}, ${p.z.toFixed(1)}`);
      assert.ok(!inChannel(p.x, 0), `${p.id} off the river`);
    }
  });
  for (const s of ['walking', 'crossing', 'waiting', 'standing']) assert.ok(states.has(s), `someone is ${s} (${[...states].join(', ')})`);
  a.dispose();
});

test('the crowd does not walk in step', () => {
  const a = createAmbient(NET, 'high', { seed: 13 });
  a.setDensity(1);
  run(a, 20, 0.1);
  const walking = a.people().filter((p) => p.state === 'walking');
  assert.ok(walking.length > 200, `a crowd walks (${walking.length})`);
  // Their strides are out of step: the phases spread round the circle.
  const cx = walking.reduce((s, p) => s + Math.cos(p.phase), 0) / walking.length;
  const sx = walking.reduce((s, p) => s + Math.sin(p.phase), 0) / walking.length;
  assert.ok(Math.hypot(cx, sx) < 0.15, `stride phases spread (resultant ${Math.hypot(cx, sx).toFixed(3)})`);
  const sd = (v: number[]): number => {
    const m = v.reduce((s, x) => s + x, 0) / v.length;
    return Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / v.length);
  };
  assert.ok(sd(walking.map((p) => p.cadence)) > 0.06, 'cadence varies');
  assert.ok(sd(walking.map((p) => p.speed)) > 0.08, 'pace varies');
  assert.ok(sd(walking.map((p) => p.height)) > 0.05, 'height varies');
  assert.ok(sd(walking.map((p) => p.build)) > 0.04, 'build varies');
  assert.ok(new Set(walking.map((p) => p.coat.join())).size >= 10, 'coats differ');
  const groups = new Map<number, number>();
  for (const p of a.people()) if (p.group >= 0) groups.set(p.group, (groups.get(p.group) ?? 0) + 1);
  assert.ok([...groups.values()].filter((n) => n >= 2).length > 20, 'people go about in twos and threes');
  a.dispose();
});
