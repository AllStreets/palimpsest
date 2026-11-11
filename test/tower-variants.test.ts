import assert from 'node:assert/strict';
import { test } from 'node:test';

import { districtOrigin, DISTRICT_PITCH } from '../shared/district-layout.js';
import type { Era } from '../shared/types.js';
import { readFileSync } from 'node:fs';

import { RENDERED } from '../app/src/city/tower/rendered.js';
import { FAMILIES, type Finish, lookFor, lookKey, pickLooks, preference, PREFERRED, renderedDistance, SEPARATION, swatch, VARIANTS } from '../app/src/city/tower/variants.js';

const ERAS: Era[] = ['stone', 'brick', 'glass', 'titanium', 'scifi'];
/** The eras the picker steers by rendered colour; the sci-fi era is steered by family (see pickLooks). */
const COLOUR_ERAS: Era[] = ['stone', 'brick', 'glass', 'titanium'];

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


test('every variant has a rendered measurement from the real scene light', () => {
  for (const era of ERAS) {
    for (const v of VARIANTS[era]) {
      const r = RENDERED[v.id];
      assert.ok(r, `${v.id} is measured (re-run the swatches shot)`);
      assert.ok(r.sun.every(Number.isFinite) && r.shade.every(Number.isFinite), `${v.id} has a sunlit and a shaded Lab colour`);
    }
  }
});

test('neighbours are steered apart by how they render: a pick is SEPARATION from every neighbour whenever such a variant exists', () => {
  for (const names of [HIS, SAMPLE, Array.from({ length: 50 }, (_, i) => `org${i % 7}/r${i}`)]) {
    const sites = names.map((repo, slot) => ({ repo, slot }));
    const looks = pickLooks(sites);
    for (const era of COLOUR_ERAS) {
      for (const s of sites) {
        const earlier = sites.filter((o) => o.slot < s.slot && blocks(o.slot, s.slot) <= 1).map((o) => looks.get(o.repo)![era]);
        const apart = (v: (typeof VARIANTS)[Era][number]): boolean => earlier.every((n) => renderedDistance(v, n) >= SEPARATION);
        if (VARIANTS[era].some(apart)) assert.ok(apart(looks.get(s.repo)![era]), `${s.repo} ${era} renders within ${SEPARATION} of a neighbour`);
      }
    }
  }
});

test('a variant repeats across the city only when no unused one renders as well apart from its neighbours and the era below', () => {
  for (const names of [HIS, SAMPLE, Array.from({ length: 30 }, (_, i) => `org${i % 7}/r${i}`)]) {
    const sites = names.map((repo, slot) => ({ repo, slot }));
    const looks = pickLooks(sites);
    for (const era of ERAS) {
      for (const s of sites) {
        const before = sites.filter((o) => o.slot < s.slot).map((o) => looks.get(o.repo)![era]);
        const mine = looks.get(s.repo)![era];
        if (!before.some((v) => v.id === mine.id)) continue;
        const near = sites.filter((o) => o.slot < s.slot && blocks(o.slot, s.slot) <= 1).map((o) => looks.get(o.repo)![era]);
        const unused = VARIANTS[era].filter((v) => !before.some((b) => b.id === v.id));
        const order: Era[] = ['stone', 'brick', 'glass', 'titanium', 'scifi'];
        const below = order.indexOf(era) > 0 ? looks.get(s.repo)![order[order.indexOf(era) - 1]] : null;
        // Unused and as good on every rule the picker ranks above reuse: apart from neighbours with the margin, apart from the era below.
        const better = unused.filter((v) => near.every((n) => renderedDistance(v, n) >= PREFERRED) && (!below || renderedDistance(v, below) >= SEPARATION));
        if (!near.every((n) => renderedDistance(mine, n) >= PREFERRED) || (below && renderedDistance(mine, below) < SEPARATION)) continue;
        assert.equal(better.length, 0, `${s.repo} repeats ${mine.id} though ${better.map((b) => b.id).join(', ')} was unused and rendered apart from its neighbours`);
      }
    }
  }
});

test('upper eras each read apart by their lit floors and rhythm', () => {
  for (const era of ['glass', 'titanium', 'scifi'] as const) {
    const seen = new Set<string>();
    for (const v of VARIANTS[era]) {
      assert.ok(v.lights, `${v.id} sets its lights`);
      const sig = [Math.round(v.lights!.warm * 5), v.pitch ?? 0, v.depth ?? 1, v.spandrel ?? 0, v.seams ?? false, v.glass.channel ?? false, v.family ?? ''].join('|');
      assert.ok(!seen.has(sig), `${v.id} reads the same as another ${era} variant from afar (${sig})`);
      seen.add(sig);
    }
  }
});


test('a variant is measured at the heights short towers stand at as well as high', () => {
  for (const era of ERAS) {
    for (const v of VARIANTS[era]) {
      const r = RENDERED[v.id];
      assert.ok(r.sunLow && r.shadeLow, `${v.id} has a low measurement`);
    }
  }
});

test("a tower's adjacent eras render apart from each other whenever such a pick exists", () => {
  const order: Era[] = COLOUR_ERAS;
  for (const names of [HIS, SAMPLE, Array.from({ length: 40 }, (_, i) => `org${i % 7}/r${i}`)]) {
    const sites = names.map((repo, slot) => ({ repo, slot }));
    const looks = pickLooks(sites);
    for (const s of sites) {
      const look = looks.get(s.repo)!;
      for (let e = 1; e < order.length; e++) {
        const below = look[order[e - 1]];
        const near = sites.filter((o) => o.slot < s.slot && blocks(o.slot, s.slot) <= 1).map((o) => looks.get(o.repo)![order[e]]);
        const both = VARIANTS[order[e]].filter((v) => renderedDistance(v, below) >= SEPARATION && near.every((n) => renderedDistance(v, n) >= SEPARATION));
        if (both.length) assert.ok(renderedDistance(look[order[e]], below) >= SEPARATION, `${s.repo}: ${look[order[e]].id} renders within ${SEPARATION} of ${below.id} below it`);
      }
    }
  }
});

test('the picker takes the margin whenever a variant clears it: PREFERRED from neighbours and SEPARATION from the era below', () => {
  assert.ok(PREFERRED >= SEPARATION + 2);
  const order: Era[] = COLOUR_ERAS;
  for (const names of [HIS, SAMPLE, Array.from({ length: 40 }, (_, i) => `org${i % 7}/r${i}`)]) {
    const sites = names.map((repo, slot) => ({ repo, slot }));
    const looks = pickLooks(sites);
    for (const s of sites) {
      for (const [e, era] of order.entries()) {
        const below = e > 0 ? looks.get(s.repo)![order[e - 1]] : null;
        const near = sites.filter((o) => o.slot < s.slot && blocks(o.slot, s.slot) <= 1).map((o) => looks.get(o.repo)![era]);
        const clears = (v: (typeof VARIANTS)[Era][number]): boolean => near.every((n) => renderedDistance(v, n) >= PREFERRED) && (!below || renderedDistance(v, below) >= SEPARATION);
        if (VARIANTS[era].some(clears)) assert.ok(clears(looks.get(s.repo)![era]), `${s.repo} ${era} passed over a variant that clears the margin`);
      }
    }
  }
});

/**
 * The looks of Connor's six and the sample's six, pinned. They come from
 * rendered.ts, so a re-measure that would change the materials of a tower
 * people already know fails here, and has to be accepted on purpose by
 * updating this list in the same commit as rendered.ts.
 */
const PINNED: Record<string, string> = {
  // Round 5: the four crowns became the six sci-fi families, so every sci-fi id here is new. Stone, brick, glass and
  // titanium are the round 4 pins, unchanged.
  // AUD-C (2026-11-11): the titanium cladding was dulled (its fins read as lit copper strips) and re-measured, and
  // the duller bronze now renders within SEPARATION of black, so five towers' titanium picks moved: ONEXUS and
  // assay-kit to zinc, quarry and blank-slate to bronze, kumo to black. Deliberate; every other era holds.
  'AllStreets/beagle': 'stone:marble,brick:green-terracotta,glass:blue,titanium:titanium,scifi:deco',
  'AllStreets/palimpsest': 'stone:dark-granite,brick:salmon,glass:channel,titanium:black,scifi:organic',
  'AllStreets/teardown': 'stone:pink-granite,brick:terracotta,glass:bronze,titanium:copper,scifi:arcology',
  'AllStreets/understudy': 'stone:marble,brick:ironspot,glass:green,titanium:bronze,scifi:needle',
  'AllStreets/ONEXUS': 'stone:dark-granite,brick:cream,glass:channel,titanium:zinc,scifi:cluster',
  'AllStreets/Chicago-Open-World': 'stone:limestone,brick:red,glass:green,titanium:bronze,scifi:ziggurat',
  'tidewater/harbor-ledger': 'stone:pink-granite,brick:green-terracotta,glass:green,titanium:bronze,scifi:ziggurat',
  'kestrel/fieldnotes': 'stone:marble,brick:salmon,glass:channel,titanium:copper,scifi:organic',
  'lantern/assay-kit': 'stone:dark-granite,brick:terracotta,glass:bronze,titanium:zinc,scifi:needle',
  'ferro/quarry': 'stone:limestone,brick:red,glass:blue,titanium:bronze,scifi:arcology',
  'hoshi/kumo': 'stone:sandstone,brick:cream,glass:channel,titanium:black,scifi:deco',
  'alder/blank-slate': 'stone:marble,brick:ironspot,glass:green,titanium:bronze,scifi:cluster',
};

test('a re-measure never silently changes the look of a known tower', () => {
  for (const names of [HIS, SAMPLE]) {
    const looks = pickLooks(names.map((repo, slot) => ({ repo, slot })));
    for (const n of names) assert.equal(lookKey(looks.get(n)!), PINNED[n], `${n} changed look`);
  }
});

test('the sci-fi era is six families, one per variant, each in its own architectural language', () => {
  assert.equal(FAMILIES.length, 6);
  const seen = new Set<string>();
  for (const v of VARIANTS.scifi) {
    assert.ok(v.family, `${v.id} names its family`);
    assert.ok(!seen.has(v.family!), `${v.id} shares the ${v.family} family with another variant`);
    seen.add(v.family!);
  }
  for (const f of FAMILIES) assert.ok(seen.has(f), `the ${f} family has a variant`);
  // Only the sci-fi era builds in families.
  for (const era of ERAS) if (era !== 'scifi') for (const v of VARIANTS[era]) assert.equal(v.family, undefined, `${v.id} has a family`);
  // Reachable and deterministic, like any variant.
  const reached = new Set<string>();
  for (let i = 0; i < 200; i++) reached.add(lookFor(`o/r${i}`).scifi.family!);
  assert.equal(reached.size, FAMILIES.length, 'every family is reachable');
  // Families are told apart by massing before colour: a city of six towers shows all six, whatever their names.
  for (const names of [HIS, SAMPLE, Array.from({ length: 6 }, (_, i) => `org${i}/r${i * 11}`)]) {
    const looks = pickLooks(names.map((repo, slot) => ({ repo, slot })));
    assert.equal(new Set(names.map((n) => looks.get(n)!.scifi.family)).size, FAMILIES.length, `${names[0]}...: six towers, six families`);
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

test('nothing regenerates rendered.ts on its own: no default capture measures, and only SWATCH_WRITE=1 writes it', () => {
  const src = readFileSync(new URL('../tools/capture.ts', import.meta.url), 'utf8');
  const defaults = /const wanted = [^;]*?\[([^\]]*)\]/.exec(src)?.[1] ?? '';
  assert.ok(defaults.length > 0, 'found the default shot list');
  assert.ok(!defaults.includes('swatches'), 'the default capture does not measure');
  const writes = src.split('\n').filter((l) => l.includes("'rendered.ts'") && l.includes('writeFileSync'));
  assert.ok(writes.length === 1 && writes[0].includes("process.env.SWATCH_WRITE === '1'"), 'the one write into the app is guarded by SWATCH_WRITE=1');
  const pkg = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
  assert.ok(!/swatches|SWATCH_WRITE/.test(pkg), 'no npm script measures');
  const head = readFileSync(new URL('../app/src/city/tower/rendered.ts', import.meta.url), 'utf8').slice(0, 900);
  assert.ok(/VERSIONED DATA/.test(head) && /city-wide look change/.test(head), 'rendered.ts says what regenerating it means');
});
