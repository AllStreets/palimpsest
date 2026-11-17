import assert from 'node:assert/strict';
import { test } from 'node:test';

import * as THREE from 'three';

import { lotParts, SECTIONS, type Face, type Lot } from '../app/src/city/lots.js';
import { AWNING, cornerBay, CUT, cutOf, frontWidth, HOODS, NAMED_KINDS, NAMES_PER_SET, packShopfront, SHOP_NAMES, SHOP_SLOTS, shopBays, shopfrontPlan, type ShopfrontPlan, signRow, signRows, unpackShopfront } from '../app/src/city/shopfronts.js';

const plan = (seed: number, o: Partial<Parameters<typeof shopfrontPlan>[0]> = {}): ShopfrontPlan =>
  shopfrontPlan({ archetype: 'walkup', hood: 'residential', w: 12, d: 10, front: ['pz'], seed, ...o });

test('bays sit symmetrically between the corners: as many whole bays as the face holds', () => {
  assert.equal(shopBays(21, 4.2), 5);
  assert.equal(shopBays(3, 4.2), 1);
  assert.equal(shopBays(10, 4.0), 3, 'rounds to the nearest whole bay');
});

test('a plan is deterministic for its inputs and differs by seed', () => {
  assert.deepEqual(plan(7), plan(7));
  const seeds = Array.from({ length: 40 }, (_, i) => JSON.stringify(plan(i)));
  assert.ok(new Set(seeds).size > 30, 'forty seeds give more than thirty different fronts');
});

test('each face carries one kind per bay, up to the pack\'s slots', () => {
  const p = plan(3, { w: 70, d: 9, front: ['pz', 'px'] });
  assert.equal(p.x.length, Math.min(SHOP_SLOTS, shopBays(9, p.bay)), 'the x faces are as wide as the lot is deep');
  assert.equal(p.z.length, SHOP_SLOTS, 'a 70 m face has more bays than slots; the kinds repeat past the twelfth');
  assert.equal(p.awningsZ.length, p.z.length);
});

test('a glass office opens as a lobby: one tenant, no awnings', () => {
  for (let s = 0; s < 30; s++) {
    const p = plan(s, { archetype: 'glass', hood: 'core', w: 30, d: 30, front: ['pz', 'px'] });
    assert.equal(p.frontage, 1);
    assert.ok(p.z.every((k) => k === 'lobby' || k === 'shop'), `a lobby front is lobby bays with at most a shop at an end (${p.z.join(',')})`);
    assert.ok(p.awningsZ.every((a) => !a) && p.awningsX.every((a) => !a), 'no awning on a curtain wall');
  }
});

test('the district shows in the fronts: residential walk-ups hang awnings, the core does not; the industrial edge is mostly shut', () => {
  const share = (o: Partial<Parameters<typeof shopfrontPlan>[0]>, pick: (p: ShopfrontPlan) => boolean[]): number => {
    let on = 0;
    let n = 0;
    for (let s = 0; s < 120; s++) {
      for (const v of pick(plan(s, o))) {
        n++;
        if (v) on++;
      }
    }
    return on / n;
  };
  const awnings = (p: ShopfrontPlan): boolean[] => p.awningsZ;
  const shut = (p: ShopfrontPlan): boolean[] => p.z.map((k) => k === 'shut');
  const cafes = (p: ShopfrontPlan): boolean[] => p.z.map((k) => k === 'cafe');
  assert.ok(share({ archetype: 'walkup', hood: 'residential' }, awnings) > 0.3, 'residential walk-ups: awnings on more than three bays in ten');
  assert.ok(share({ archetype: 'commercial', hood: 'core', w: 24, d: 18 }, awnings) < 0.15, 'the core: few awnings');
  assert.ok(share({ archetype: 'walkup', hood: 'industrial' }, shut) > share({ archetype: 'walkup', hood: 'residential' }, shut) + 0.2, 'more shut fronts at the industrial edge');
  assert.ok(share({ archetype: 'walkup', hood: 'residential' }, cafes) > 0.2, 'cafes along the residential streets');
});

test('only a street front gets awnings, and a back face is mostly shut', () => {
  for (let s = 0; s < 40; s++) {
    const p = plan(s, { front: ['pz'] });
    assert.ok(p.awningsX.every((a) => !a), 'no awnings on a face that meets no street');
  }
  let shut = 0;
  let n = 0;
  for (let s = 0; s < 120; s++) {
    const p = plan(s, { front: ['pz'] });
    for (const k of p.x) {
      n++;
      if (k === 'shut') shut++;
    }
  }
  assert.ok(shut / n > 0.6, `a back face is mostly shut (${(shut / n).toFixed(2)})`);
});

test('the pack carries the plan to the shader and back without loss', () => {
  for (let s = 0; s < 60; s++) {
    const p = plan(s, { w: 40 + (s % 5) * 7, d: 14 + (s % 3) * 9, front: ['pz', 'nx'], archetype: (['walkup', 'commercial', 'midcentury', 'brutalist'] as const)[s % 4] });
    const packed = packShopfront(p);
    for (const v of packed) assert.ok(Number.isInteger(v) && v >= 0 && v < 2 ** 24, 'each channel is a whole number a float32 holds exactly');
    const back = unpackShopfront(packed, p.x.length, p.z.length);
    assert.deepEqual(back, { bay: p.bay, hood: p.hood, palette: p.palette, frontage: p.frontage, x: p.x, z: p.z, awningsX: p.awningsX, awningsZ: p.awningsZ });
  }
});

test('a lot hangs its awnings on its street fronts, over the glass, one per awning bay', () => {
  const s = SECTIONS.walkup;
  const front: Face[] = ['pz', 'px'];
  const lot: Lot = {
    x: 100,
    z: -40,
    w: 16,
    d: 12,
    h: s.ground + 4 * s.floor + s.parapet,
    archetype: 'walkup',
    hood: 'residential',
    tone: 'red',
    colour: new THREE.Color(0.4, 0.2, 0.15),
    accent: new THREE.Color(0.8, 0.75, 0.7),
    style: [0, 0.3, 0.5, 0.2],
    roof: 'flat',
    front,
    stack: 0,
    index: 0,
    shop: packShopfront(shopfrontPlan({ archetype: 'walkup', hood: 'residential', w: 16, d: 12, front, seed: 11 })),
  };
  const p = shopfrontPlan({ archetype: 'walkup', hood: 'residential', w: 16, d: 12, front, seed: 11 });
  const want = p.awningsZ.filter(Boolean).length + p.awningsX.filter(Boolean).length;
  const awnings = lotParts(lot).filter((q) => q.kind === 'awning');
  assert.equal(awnings.length, want);
  assert.ok(want > 0, 'the seed hangs at least one awning');
  for (const a of awnings) {
    assert.equal(a.sz, AWNING.reach, 'its reach lies along its own z, turned to the face');
    const onPz = Math.abs(a.z - (lot.z + lot.d / 2 + AWNING.reach / 2)) < 1e-6 && a.rot === undefined;
    const onPx = Math.abs(a.x - (lot.x + lot.w / 2 + AWNING.reach / 2)) < 1e-6 && Math.abs((a.rot ?? 0) - Math.PI / 2) < 1e-9;
    assert.ok(onPz || onPx, `an awning stands just off a street front, turned to it (${a.x}, ${a.z}, ${a.rot})`);
    assert.ok(a.y > s.ground - 1.3 && a.y < s.ground, 'hung at the head of the glass, under the fascia');
    assert.ok(a.colour, 'in its own cloth');
  }
  assert.ok(AWNING.reach > 1 && AWNING.reach < 2, 'an awning reaches a pavement\'s width out');
});

test('every district has its own shop names, in an older and a modern set, each short enough for a fascia', () => {
  const all = new Set<string>();
  for (const h of HOODS) {
    for (const k of NAMED_KINDS) {
      const sets = SHOP_NAMES[h][k as 'shop' | 'cafe' | 'lobby'];
      for (const set of sets) {
        assert.equal(set.length, NAMES_PER_SET, `${h} ${k}: six names a set`);
        for (const n of set) {
          assert.ok(n.length >= 4 && n.length <= 26, `${n}: a name a fascia can carry`);
          assert.ok(!all.has(n) || k === 'lobby', `${n} is used twice`);
          all.add(n);
        }
      }
      assert.notDeepEqual(sets[0], sets[1], `${h} ${k}: the eras differ`);
    }
  }
  const rows = signRows();
  assert.equal(rows.length, HOODS.length * NAMED_KINDS.length * 2 * NAMES_PER_SET);
  // The row the shader computes is the row the atlas drew.
  assert.equal(rows[signRow(HOODS.indexOf('midtown'), 'cafe', false, 2)], SHOP_NAMES.midtown.cafe[1][2]);
  assert.equal(rows[signRow(HOODS.indexOf('industrial'), 'shop', true, 7)], SHOP_NAMES.industrial.shop[0][1]);
  const p = plan(3, { hood: 'spine' });
  assert.equal(p.hood, HOODS.indexOf('spine'), 'the plan carries its district to the shader');
});

// The cut corners (Phase 5 Task 2): a corner lot of offices or slabs cuts its street corner, and its shopping front
// is the straight run between the cuts, so the bays the awnings hang on are the bays the glass shows.

test('a cut corner shortens the shopping front to the straight run between the cuts', () => {
  assert.ok(CUT.chamfer > 0 && CUT.chamfer < 0.25 && CUT.round > CUT.chamfer && CUT.round < 0.25, 'the kit fractions (kits.py chamfer_box, round_box)');
  assert.equal(cutOf('commercial', ['px', 'pz'], 0.6), 'chamfer');
  assert.equal(cutOf('glass', ['nx', 'nz'], 0.9), 'chamfer');
  assert.equal(cutOf('midcentury', ['px', 'nz'], 0.5), 'round', 'a streamline curve on a mid-century slab');
  assert.equal(cutOf('commercial', ['px'], 0.9), null, 'one street front: no corner to cut');
  assert.equal(cutOf('commercial', ['px', 'pz'], 0.2), null, 'the lower variants keep their square corners');
  assert.equal(cutOf('walkup', ['px', 'pz'], 0.9), null, 'walk-ups and the rest stay square');
  assert.equal(frontWidth(20, null), 20);
  assert.ok(Math.abs(frontWidth(20, 'chamfer') - 20 * (1 - 2 * CUT.chamfer)) < 1e-9);
  assert.ok(Math.abs(frontWidth(25, 'round') - 25 * (1 - 2 * CUT.round)) < 1e-9);
});

test('a cut lot hangs its awnings within the straight run, and its corner bay takes the x front\'s first kind', () => {
  const s = SECTIONS.commercial;
  const front: Face[] = ['pz', 'px'];
  const seed = 5;
  const plan = shopfrontPlan({ archetype: 'commercial', hood: 'residential', w: 24, d: 20, front, seed, cut: 'chamfer' });
  const lot: Lot = {
    x: 100,
    z: -40,
    w: 24,
    d: 20,
    h: s.ground + 6 * s.floor + s.parapet,
    archetype: 'commercial',
    hood: 'residential',
    tone: 'buff',
    colour: new THREE.Color(0.5, 0.4, 0.3),
    accent: new THREE.Color(0.8, 0.75, 0.7),
    style: [0, 0.3, 0.5, 0.8],
    roof: 'flat',
    front,
    stack: 0,
    index: 0,
    shop: packShopfront(plan),
  };
  assert.ok(lotParts(lot).some((p) => p.chamfer), 'the variant cuts the corner');
  // The plan's bays are counted over the straight run on each front.
  assert.equal(plan.z.length, Math.min(SHOP_SLOTS, shopBays(frontWidth(24, 'chamfer'), plan.bay)));
  assert.equal(plan.x.length, Math.min(SHOP_SLOTS, shopBays(frontWidth(20, 'chamfer'), plan.bay)));
  const awnings = lotParts(lot).filter((q) => q.kind === 'awning');
  const cutZ = 24 * CUT.chamfer;
  const cutX = 20 * CUT.chamfer;
  for (const a of awnings) {
    const onPz = a.rot === undefined;
    if (onPz) assert.ok(a.x - a.sx / 2 >= lot.x - 12 + cutZ - 1e-6 && a.x + a.sx / 2 <= lot.x + 12 - cutZ + 1e-6, `an awning on the z front stays clear of the cuts (${a.x}, ${a.sx})`);
    else assert.ok(a.z - a.sx / 2 >= lot.z - 10 + cutX - 1e-6 && a.z + a.sx / 2 <= lot.z + 10 - cutX + 1e-6, `an awning on the x front stays clear of the cuts (${a.z}, ${a.sx})`);
  }
  assert.equal(cornerBay(plan), plan.x[0], 'the shader reads the same slot for the corner');
  // A square lot plans over its full fronts, as it always did.
  const square = shopfrontPlan({ archetype: 'commercial', hood: 'residential', w: 24, d: 20, front, seed });
  assert.equal(square.z.length, Math.min(SHOP_SLOTS, shopBays(24, square.bay)));
});
