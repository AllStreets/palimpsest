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
