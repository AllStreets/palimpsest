import assert from 'node:assert/strict';
import { test } from 'node:test';

import { districtOrigin, DISTRICT_PITCH } from '../shared/district-layout.js';
import type { Era } from '../shared/types.js';
import { readFileSync } from 'node:fs';

import { RENDERED } from '../app/src/city/tower/rendered.js';
import { FAMILIES, type Finish, lookFor, lookKey, pickLooks, preference, PREFERRED, renderedDistance, SEPARATION, swatch, VARIANTS } from '../app/src/city/tower/variants.js';
import * as variants from '../app/src/city/tower/variants.js';

/** The scans' body and joint split, read off the module so a build without it fails its own test alone. */
const SCAN_STATS = ((variants as Record<string, unknown>).SCAN_STATS ?? {}) as Record<string, { lo: number; hi: number; refBody: number; refJoint: number }>;

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


test('a variant freed by a removed repo is reused only in its own district', () => {
  // A repo removed from the city keeps its slot, so its district keeps its look in reserve: no tower anywhere else
  // re-picks, none takes the freed variant, and the repo, back on its slot, stands in exactly the look it had.
  for (const names of [HIS, SAMPLE, Array.from({ length: 30 }, (_, i) => `org${i % 7}/r${i}`)]) {
    const sites = names.map((repo, slot) => ({ repo, slot }));
    const base = pickLooks(sites);
    for (let k = 0; k < sites.length; k += 2) {
      const gone = sites[k];
      const after = pickLooks(sites.map((s) => (s === gone ? { ...s, gone: true } : s)));
      assert.equal(after.has(gone.repo), false, `${gone.repo} was removed: it stands nowhere`);
      for (const s of sites) {
        if (s === gone) continue;
        assert.equal(lookKey(after.get(s.repo)!), lookKey(base.get(s.repo)!), `${s.repo} re-picked when ${gone.repo} was removed`);
      }
      const back = pickLooks(sites);
      assert.equal(lookKey(back.get(gone.repo)!), lookKey(base.get(gone.repo)!), `${gone.repo} came back in another look`);
    }
  }
});

test("each scan's split between body and joint straddles the middle of its two references (the granite window)", () => {
  // The recolour reads a texel as body past one end of the window and as joint past the other: a window that misses
  // the midpoint between the scan's typical body and joint luminance sends half its body to the joint colour, and a
  // window a hundredth wide turns the grain into a two-tone speckle (granite's was 0.05 to 0.06 about a midpoint of 0.064).
  assert.ok(Object.keys(SCAN_STATS).length >= 6, 'every scan has its split (variants.ts SCAN_STATS)');
  for (const [scan, st] of Object.entries(SCAN_STATS)) {
    const lo = Math.min(st.lo, st.hi);
    const hi = Math.max(st.lo, st.hi);
    const mid = (st.refBody + st.refJoint) / 2;
    assert.ok(lo <= mid && mid <= hi, `${scan}: window ${lo} to ${hi} misses the midpoint ${mid.toFixed(4)}`);
    assert.ok(hi - lo >= 0.02, `${scan}: window ${(hi - lo).toFixed(3)} wide is a step, not a blend`);
  }
});

test('the ceramic glaze stays cool in the low sun: a low warm band in its body and a glaze\'s reflection, not a mirror\'s', () => {
  // Task 7: under the orange key a glazed body's red is what the sun pushes hardest, and an environment weight of 4.2
  // made the glaze a mirror of the orange horizon. The organic family's glaze keeps its red at most 0x3c and under a
  // third of its blue, and its sky reflection at most 2.6 (a polished stone's weight).
  const organic = VARIANTS.scifi.find((v) => v.family === 'organic')!;
  const wall = organic.wall as Extract<Finish, { kind: 'scan' }>;
  const r = (wall.body >> 16) & 0xff;
  const b = wall.body & 0xff;
  assert.ok(r <= 0x3c && r / b <= 0.33, `the glaze's body red ${r} against blue ${b}`);
  const env = (variants as Record<string, unknown>).GLAZE_ENV as number | undefined;
  assert.ok(env !== undefined && env <= 2.6 && env >= 1.5, `the glaze's sky reflection ${env}`);
});

test('the sample corner keeps SEPARATION', () => {
  // Every pair of neighbouring districts in the sample's six and in his six, whichever was placed first, reads apart
  // in every era the picker steers by colour (the corner where quarry and kumo meet was 5.8 in stone).
  for (const names of [SAMPLE, HIS]) {
    const sites = names.map((repo, slot) => ({ repo, slot }));
    const looks = pickLooks(sites);
    for (const era of COLOUR_ERAS) {
      for (const a of sites) {
        for (const b of sites) {
          if (b.slot <= a.slot || blocks(a.slot, b.slot) > 1) continue;
          const d = renderedDistance(looks.get(a.repo)![era], looks.get(b.repo)![era]);
          assert.ok(d >= SEPARATION, `${a.repo} and ${b.repo} in ${era} render ${d.toFixed(2)} apart`);
        }
      }
    }
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
        // In stone the picker also keeps the next district on the spiral free to read apart (pickLooks rule 5): an
        // unused variant that would leave an empty neighbouring block with nothing SEPARATION from all round it is no better.
        const at = districtOrigin(s.slot);
        const boxedIn = (v: (typeof VARIANTS)[Era][number]): number => {
          if (era !== 'stone') return 0;
          let n = 0;
          for (let dx = -1; dx <= 1; dx++) {
            for (let dz = -1; dz <= 1; dz++) {
              const b = { x: at.x + dx * DISTRICT_PITCH, z: at.z + dz * DISTRICT_PITCH };
              if ((!dx && !dz) || (!b.x && !b.z)) continue;
              const held = sites.filter((o) => o.slot < s.slot);
              if (held.some((o) => districtOrigin(o.slot).x === b.x && districtOrigin(o.slot).z === b.z)) continue;
              const round = held
                .filter((o) => Math.max(Math.abs(districtOrigin(o.slot).x - b.x), Math.abs(districtOrigin(o.slot).z - b.z)) === DISTRICT_PITCH)
                .map((o) => looks.get(o.repo)![era]);
              round.push(v);
              if (!VARIANTS[era].some((w) => round.every((r) => renderedDistance(r, w) >= SEPARATION))) n++;
            }
          }
          return n;
        };
        const better = unused.filter(
          (v) => near.every((n) => renderedDistance(v, n) >= PREFERRED) && (!below || renderedDistance(v, below) >= SEPARATION) && boxedIn(v) <= boxedIn(mine),
        );
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
  'AllStreets/palimpsest': 'stone:limestone,brick:salmon,glass:bronze,titanium:copper,scifi:organic',
  'AllStreets/teardown': 'stone:dark-granite,brick:cream,glass:channel,titanium:black,scifi:arcology',
  'AllStreets/understudy': 'stone:pink-granite,brick:ironspot,glass:green,titanium:bronze,scifi:needle',
  'AllStreets/ONEXUS': 'stone:marble,brick:salmon,glass:black,titanium:zinc,scifi:cluster',
  // Phase 5 Task 7: the stone pick looks one district ahead (pickLooks rule 5), so a corner is never left with no
  // stone that reads apart from both its neighbours: the sample's quarry and kumo met at 5.8 in stone. Deliberate, and
  // stone only: quarry limestone to marble and kumo sandstone to pink granite; Chicago-Open-World limestone to marble
  // (its limestone left the next block on the spiral with no stone apart from both it and ONEXUS's dark granite).
  // Phase 5 Task 15 (Decision 6): the tables re-measured once in true light (the brief's scrim and the old haze veil
  // gone), so the rendered colours moved by 5 to 15 L and the picker steered every corner again. Deliberate, for his
  // approval on the before and after sheet: eleven of the twelve change at least one era; only beagle holds. Of the
  // three Task 7 changed in stone, Chicago-Open-World goes marble to sandstone, quarry marble to travertine and kumo
  // pink granite to limestone.
  'AllStreets/Chicago-Open-World': 'stone:sandstone,brick:red,glass:green,titanium:bronze,scifi:ziggurat',
  'tidewater/harbor-ledger': 'stone:pink-granite,brick:green-terracotta,glass:black,titanium:zinc,scifi:ziggurat',
  'kestrel/fieldnotes': 'stone:dark-granite,brick:salmon,glass:bronze,titanium:copper,scifi:organic',
  'lantern/assay-kit': 'stone:marble,brick:red,glass:green,titanium:bronze,scifi:needle',
  'ferro/quarry': 'stone:travertine,brick:cream,glass:blue,titanium:black,scifi:arcology',
  'hoshi/kumo': 'stone:limestone,brick:green-terracotta,glass:channel,titanium:titanium,scifi:deco',
  'alder/blank-slate': 'stone:marble,brick:salmon,glass:green,titanium:black,scifi:cluster',
};

test('a re-measure never silently changes the look of a known tower', () => {
  for (const names of [HIS, SAMPLE]) {
    const looks = pickLooks(names.map((repo, slot) => ({ repo, slot })));
    for (const n of names) assert.equal(lookKey(looks.get(n)!), PINNED[n], `${n} changed look`);
  }
});

/**
 * The same twelve looks' material parameters (Task 15): a stamp of every
 * finish, glass and family each era's variant is built from (variants.ts
 * lookParams), so a change to what a known tower is made of fails here even
 * when its variant ids hold, and is accepted on purpose by updating this
 * list with the re-measure it calls for.
 */
const PINNED_PARAMS: Record<string, string> = {
  'AllStreets/beagle': '3e0b9790',
  'AllStreets/palimpsest': '43fe5407',
  'AllStreets/teardown': 'beab9d02',
  'AllStreets/understudy': '91263941',
  'AllStreets/ONEXUS': '6d249d61',
  'AllStreets/Chicago-Open-World': '50762ff3',
  'tidewater/harbor-ledger': '12a9926a',
  'kestrel/fieldnotes': '41ac6d30',
  'lantern/assay-kit': 'f610d130',
  'ferro/quarry': 'dbb73d8e',
  'hoshi/kumo': '5d995f25',
  'alder/blank-slate': 'e2a3fb96',
};

test('the pins cover the material parameters, not only the look ids', () => {
  const lookParams = (variants as Record<string, unknown>).lookParams as ((look: ReturnType<typeof lookFor>) => string) | undefined;
  assert.ok(lookParams, 'variants.ts stamps a look by its parameters');
  for (const names of [HIS, SAMPLE]) {
    const looks = pickLooks(names.map((repo, slot) => ({ repo, slot })));
    for (const n of names) assert.equal(lookParams!(looks.get(n)!), PINNED_PARAMS[n], `${n}: what its look is made of changed`);
  }
  // A parameter changed under the same ids moves the stamp.
  const look = lookFor('AllStreets/beagle');
  const stone = look.stone;
  assert.notEqual(lookParams!({ ...look, stone: { ...stone, glass: { ...stone.glass, tint: (stone.glass.tint ?? 0) ^ 1 } } }), lookParams!(look));
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

// Task 15: the contrast checks read each variant's colour as the city renders it (rendered.ts: measured through the
// scene's light, haze and tone mapping), not its declared swatch, which no one sees.
const R = variants as Record<string, unknown>;
const renderedFrom = (R.renderedFrom ?? (() => 0)) as (id: string, lab: [number, number, number]) => number;
const renderedChroma = (R.renderedChroma ?? (() => Infinity)) as (id: string) => number;

test('contrast is checked on rendered colour: the bronze datum and the Claude amber stand apart from every variant as rendered', () => {
  assert.ok(R.renderedFrom && R.renderedChroma, 'variants.ts reads rendered colour for its checks');
  for (const era of ERAS) {
    for (const v of VARIANTS[era]) {
      const fromDatum = renderedFrom(v.id, lab(DATUM));
      const fromAmber = renderedFrom(v.id, lab(AMBER));
      assert.ok(fromDatum >= 18, `${v.id} renders ${fromDatum.toFixed(1)} from the datum`);
      assert.ok(fromAmber >= 30, `${v.id} renders ${fromAmber.toFixed(1)} from the Claude amber`);
    }
  }
});

/**
 * The rendered ceiling. The declared swatches were held to chroma 30; the
 * loudest variant as rendered in true light, the salmon brick, reads 30.3,
 * so the ceiling is that measured maximum with under a point to spare, and
 * any variant made louder than the palette is now fails.
 */
const RENDERED_CHROMA_MAX = 31;

test('variants stay inside the dusk palette as rendered: no candy colours', () => {
  for (const era of ERAS) {
    for (const v of VARIANTS[era]) {
      const chroma = renderedChroma(v.id);
      assert.ok(chroma <= RENDERED_CHROMA_MAX, `${v.id} renders at chroma ${chroma.toFixed(1)}, too loud`);
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
  // A bare capture runs README_SHOTS, the README's media.
  const defaults = /const README_SHOTS = \[([^\]]*)\]/.exec(src)?.[1] ?? '';
  assert.ok(defaults.length > 0, 'found the default shot list');
  assert.ok(!defaults.includes('swatches'), 'the default capture does not measure');
  const writes = src.split('\n').filter((l) => l.includes("'rendered.ts'") && l.includes('writeFileSync'));
  assert.ok(writes.length === 1 && writes[0].includes("process.env.SWATCH_WRITE === '1'"), 'the one write into the app is guarded by SWATCH_WRITE=1');
  const pkg = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
  assert.ok(!/swatches|SWATCH_WRITE/.test(pkg), 'no npm script measures');
  const head = readFileSync(new URL('../app/src/city/tower/rendered.ts', import.meta.url), 'utf8').slice(0, 900);
  assert.ok(/VERSIONED DATA/.test(head) && /city-wide look change/.test(head), 'rendered.ts says what regenerating it means');
});
