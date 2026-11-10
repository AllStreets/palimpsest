import assert from 'node:assert/strict';
import { test } from 'node:test';

import { districtOrigin, DISTRICT_PITCH } from '../shared/district-layout.js';
import type { Era } from '../shared/types.js';
import { type Finish, lookFor, pickLooks, swatch, VARIANTS } from '../app/src/city/tower/variants.js';

const ERAS: Era[] = ['stone', 'brick', 'glass', 'titanium', 'scifi'];

/** Chebyshev distance between two slots' blocks on the district grid. */
function blocks(a: number, b: number): number {
  const p = districtOrigin(a);
  const q = districtOrigin(b);
  return Math.max(Math.abs(p.x - q.x), Math.abs(p.z - q.z)) / DISTRICT_PITCH;
}

/** Connor's six, by slot, and the sample's six: real-looking names over the first slots of the spiral. */
const HIS = ['AllStreets/beagle', 'AllStreets/palimpsest', 'AllStreets/teardown', 'AllStreets/understudy', 'AllStreets/ONEXUS', 'AllStreets/Chicago-Open-World'];
const SAMPLE = ['tidewater/harbor-ledger', 'kestrel/fieldnotes', 'lantern/assay-kit', 'ferro/quarry', 'hoshi/kumo', 'alder/blank-slate'];

test('every era has at least three variants, each laid in its own era with a unique id', () => {
  const ids = new Set<string>();
  for (const era of ERAS) {
    assert.ok(VARIANTS[era].length >= 3, `${era} has ${VARIANTS[era].length} variants`);
    for (const v of VARIANTS[era]) {
      assert.equal(v.era, era, `${v.id} is filed under ${era}`);
      assert.ok(!ids.has(v.id), `${v.id} is unique`);
      ids.add(v.id);
    }
  }
});

test('a look covers every era with a variant of that era', () => {
  for (const repo of [...HIS, ...SAMPLE, 'a/b', '']) {
    const look = lookFor(repo);
    for (const era of ERAS) {
      assert.ok(look[era], `${repo}: ${era} has a variant`);
      assert.equal(look[era].era, era);
    }
  }
});

test('the picker is deterministic: same repo, same look, whatever order the city lists it in', () => {
  for (const repo of HIS) assert.deepEqual(lookFor(repo), lookFor(repo));
  const sites = HIS.map((repo, slot) => ({ repo, slot }));
  const a = pickLooks(sites);
  const b = pickLooks([...sites].reverse());
  for (const repo of HIS) {
    for (const era of ERAS) assert.equal(a.get(repo)![era].id, b.get(repo)![era].id, `${repo} ${era}`);
  }
});

test('names spread over every variant of every era', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 400; i++) {
    const look = lookFor(`owner${i}/repo-${i * 7}`);
    for (const era of ERAS) seen.add(look[era].id);
  }
  for (const era of ERAS) for (const v of VARIANTS[era]) assert.ok(seen.has(v.id), `${v.id} is reachable`);
});

test('neighbouring districts never share a variant while a free one exists', () => {
  // Fifty slots: the spiral's first rings, where every block has several neighbours.
  for (const names of [HIS, SAMPLE, Array.from({ length: 50 }, (_, i) => `org${i % 7}/r${i}`)]) {
    const sites = names.map((repo, slot) => ({ repo, slot }));
    const looks = pickLooks(sites);
    for (const era of ERAS) {
      for (const s of sites) {
        const mine = looks.get(s.repo)![era].id;
        const near = sites.filter((o) => o !== s && blocks(o.slot, s.slot) <= 1);
        // Only clashes where this district chose second: the later of the pair is the one that could have avoided it.
        const clash = near.filter((o) => o.slot < s.slot && looks.get(o.repo)![era].id === mine);
        if (clash.length === 0) continue;
        // A clash is allowed only when the neighbours that chose first (lower slots) had taken every variant.
        const earlier = near.filter((o) => o.slot < s.slot);
        const taken = new Set(earlier.map((o) => looks.get(o.repo)![era].id));
        assert.equal(taken.size, VARIANTS[era].length, `${s.repo} (slot ${s.slot}) shares ${mine} with ${clash.map((c) => c.repo).join(', ')} though a variant was free`);
      }
    }
  }
});

test("Connor's six and the sample's six are distinct from every neighbour in every era", () => {
  for (const names of [HIS, SAMPLE]) {
    const sites = names.map((repo, slot) => ({ repo, slot }));
    const looks = pickLooks(sites);
    for (const era of ERAS) {
      for (const s of sites) {
        for (const o of sites) {
          if (o === s || blocks(o.slot, s.slot) > 1) continue;
          assert.notEqual(looks.get(s.repo)![era].id, looks.get(o.repo)![era].id, `${s.repo} and ${o.repo} in ${era}`);
        }
      }
    }
  }
});

test('a tower keeps its look when later repos join the city', () => {
  const first = pickLooks(HIS.slice(0, 3).map((repo, slot) => ({ repo, slot })));
  const later = pickLooks(HIS.map((repo, slot) => ({ repo, slot })));
  for (const repo of HIS.slice(0, 3)) {
    for (const era of ERAS) assert.equal(later.get(repo)![era].id, first.get(repo)![era].id, `${repo} ${era}`);
  }
});

// ---------------------------------------------------------------- colour checks

/** CIE Lab of an sRGB hex colour (D65). */
function lab(hex: number): [number, number, number] {
  const lin = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const r = lin(((hex >> 16) & 255) / 255);
  const g = lin(((hex >> 8) & 255) / 255);
  const b = lin((hex & 255) / 255);
  const x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  const f = (t: number): number => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}
const dE = (a: number, b: number): number => {
  const p = lab(a);
  const q = lab(b);
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
};

/** The datum's polished bronze and the Claude amber, as their swatches. */
const DATUM = 0xd9c26e;
const AMBER = 0xff6a1a;

const faces = (v: (typeof VARIANTS)[Era][number]): Array<[string, Finish]> => [
  ['wall', v.wall],
  ['trim', v.trim],
  ['band', v.band],
];

test('the bronze datum and the Claude amber stand apart from every variant', () => {
  for (const era of ERAS) {
    for (const v of VARIANTS[era]) {
      for (const [slot, f] of faces(v)) {
        const s = swatch(f);
        assert.ok(dE(s, DATUM) >= 18, `${v.id} ${slot} (#${s.toString(16)}) is ${dE(s, DATUM).toFixed(1)} from the datum`);
        assert.ok(dE(s, AMBER) >= 30, `${v.id} ${slot} (#${s.toString(16)}) is ${dE(s, AMBER).toFixed(1)} from the Claude amber`);
      }
    }
  }
});

test('variants stay inside the dusk palette: no candy colours', () => {
  for (const era of ERAS) {
    for (const v of VARIANTS[era]) {
      for (const [slot, f] of faces(v)) {
        const [, a, b] = lab(swatch(f));
        const chroma = Math.hypot(a, b);
        assert.ok(chroma <= 30, `${v.id} ${slot} chroma ${chroma.toFixed(1)} is too loud`);
      }
    }
  }
});

test('within an era, variants differ from each other by material alone', () => {
  for (const era of ERAS) {
    const vs = VARIANTS[era];
    for (let i = 0; i < vs.length; i++) {
      for (let j = i + 1; j < vs.length; j++) {
        const d = Math.max(dE(swatch(vs[i].wall), swatch(vs[j].wall)), dE(swatch(vs[i].trim), swatch(vs[j].trim)) * 0.6, vs[i].glass.tint !== vs[j].glass.tint ? 12 : 0);
        assert.ok(d >= 12, `${vs[i].id} and ${vs[j].id} are only ${d.toFixed(1)} apart`);
      }
    }
  }
});
