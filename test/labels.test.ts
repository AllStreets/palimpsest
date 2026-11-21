/**
 * The city's name plates (labels.ts): a plate near the viewport's right edge
 * sets its words left of its hairline rather than clipping them, and a
 * tower's plate says what its lit and dark bands are.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import * as THREE from 'three';

import * as labels from '../app/src/city/labels.js';
import type { Floor } from '../shared/types.js';

const mod = labels as unknown as {
  plateFlips?: (x: number, words: number, viewWidth: number) => boolean;
  plateFits?: (x: number, y: number, words: number, flip: boolean, viewWidth: number, viewHeight: number, margin?: number) => boolean;
  PLATE_FIT_SPARE?: number;
  bandKey?: (floors: readonly Floor[]) => string;
};

test('a plate near the right edge sets its words left of its hairline', () => {
  assert.equal(typeof mod.plateFlips, 'function', 'the plates decide which side of the hairline their words stand');
  // Words 120 px wide on a 1512 px view: right of the hairline while they fit, left of it once they would run past.
  assert.equal(mod.plateFlips!(600, 120, 1512), false);
  assert.equal(mod.plateFlips!(1512 - 7 - 120 - 8, 120, 1512), false);
  assert.equal(mod.plateFlips!(1440, 120, 1512), true, 'Meridian at the right edge flips');
  // Never flipped where the words would then run off the left edge instead.
  assert.equal(mod.plateFlips!(60, 400, 300), false);
});

test('a plate whose name would run off the view is not shown until it fits (Task 15a)', () => {
  assert.equal(typeof mod.plateFits, 'function', 'the plates know when their words are whole on screen');
  // On screen, either side of the hairline.
  assert.equal(mod.plateFits!(600, 500, 120, false, 1512, 890), true);
  assert.equal(mod.plateFits!(1440, 500, 120, true, 1512, 890), true);
  // The foot past the right edge: flipped, the words still run off it (the overview's quarter plates in round 0).
  assert.equal(mod.plateFits!(1560, 500, 120, true, 1512, 890), false);
  // The foot past the left edge, and a name over the top of the view or a foot under its bottom.
  assert.equal(mod.plateFits!(-30, 500, 120, false, 1512, 890), false);
  assert.equal(mod.plateFits!(600, 20, 120, false, 1512, 890), false);
  assert.equal(mod.plateFits!(600, 900, 120, false, 1512, 890), false);
  // Once hidden it shows again only with PLATE_FIT_SPARE pixels to spare, so a plate at the edge does not flicker.
  assert.ok((mod.PLATE_FIT_SPARE ?? 0) >= 4);
  assert.equal(mod.plateFits!(1512 - 7 - 120 - 3, 500, 120, false, 1512, 890), true);
  assert.equal(mod.plateFits!(1512 - 7 - 120 - 3, 500, 120, false, 1512, 890, mod.PLATE_FIT_SPARE), false);
});

const floor = (i: number, state?: 'lit' | 'scar' | 'waiting'): Floor => ({
  id: `acme/w#f${i}`,
  repo: 'acme/w',
  kind: 'pr',
  refs: [],
  title: `change ${i}`,
  at: '2026-11-01T00:00:00Z',
  era: 'glass',
  size: 'medium',
  lines: 10,
  claude: false,
  founding: !state,
  url: null,
  ...(state ? { earned: { jobId: `j${i}`, runId: `r${i}`, agentId: 'a', firmId: 'f', state, reverted: false } } : {}),
});

test("a tower's plate says what its lit and dark bands are, in the inspector's words", () => {
  assert.equal(typeof mod.bandKey, 'function', 'the plate has a band key');
  assert.equal(mod.bandKey!([floor(0), floor(1)]), '', 'a tower with no market floors says nothing');
  assert.equal(mod.bandKey!([floor(0), floor(1, 'lit')]), 'A lit floor is a change a firm built here that you merged.');
  assert.equal(
    mod.bandKey!([floor(0), floor(1, 'lit'), floor(2, 'scar'), floor(3, 'waiting')]),
    'A lit floor is a change a firm built here that you merged; a dark band is a scar, work that failed inspection, kept where it failed; a floor still unlit waits on your review.',
  );
  assert.equal(mod.bandKey!([floor(2, 'scar')]), 'A dark band is a scar, work that failed inspection, kept where it failed.');
});

test("the plates' words carry their own dark ground, and the second line an ink lighter than --ink-2 (Task 15a review)", () => {
  // One source since the Task 26 merge: the stylesheet, not inline styles set by labels.ts.
  const css = readFileSync(new URL('../app/src/ui/style.css', import.meta.url), 'utf8');
  const rule = (selector: string): string => {
    const i = css.indexOf(`${selector} {`);
    assert.ok(i >= 0, `style.css has ${selector}`);
    return css.slice(i, css.indexOf('}', i + 1));
  };
  const lum = (hex: string): number => {
    const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  assert.match(rule('.plate-name,\n.plate-sub'), /text-shadow: 0 0 2px rgba\(10, 9, 12, 0\.9/, 'a tight dark shadow under the letters');
  const ink = /color: (#[0-9a-f]{6})/.exec(rule('}\n.plate-sub'))?.[1] ?? '';
  assert.ok(lum(ink) > lum('#b9b1a4') && lum(ink) < lum('#f4efe6'), `the second line's ink ${ink} sits between --ink-2 and the name's`);
  assert.doesNotMatch(readFileSync(new URL('../app/src/city/labels.ts', import.meta.url), 'utf8'), /style\.(textShadow|color)\s*=/, 'labels.ts sets no plate ink of its own');
});

test('a flipped plate sets its words right-aligned left of its hairline in style.css', () => {
  const css = readFileSync(new URL('../app/src/ui/style.css', import.meta.url), 'utf8');
  const i = css.indexOf('.plate.plate-flip .plate-name,\n.plate.plate-flip .plate-sub {');
  assert.ok(i >= 0, 'style.css has the plate-flip rule');
  const body = css.slice(i, css.indexOf('}', i));
  assert.match(body, /left: auto;/);
  assert.match(body, /right: 7px;/);
  assert.match(body, /text-align: right;/);
  assert.equal(labels.PLATE_FLIP, 'plate-flip');
});

test('two plates whose words collide after a flip: the later one waits while they overlap', () => {
  const fn = (labels as unknown as { platesToHide?: (p: Array<{ x: number; y: number; words: number; flip: boolean }>) => Set<number> }).platesToHide;
  assert.equal(typeof fn, 'function');
  // Sparrow & Co flipped left of its hairline at the right edge, the other plate right of its own just left of it: they overlap.
  const a = { x: 1300, y: 400, words: 140, flip: false };
  const b = { x: 1440, y: 410, words: 120, flip: true };
  assert.deepEqual([...fn!([a, b])], [1], 'the later plate is hidden, the earlier stays');
  assert.deepEqual([...fn!([b, a])], [1]);
  // Clear of each other, or a hidden plate that collides with nothing shown: nothing hidden.
  assert.deepEqual([...fn!([a, { ...b, y: 520 }])], []);
  assert.deepEqual([...fn!([a, { x: 700, y: 410, words: 120, flip: false }])], []);
  // A hidden plate does not hide a third that only touches it.
  const c = { x: 1440, y: 440, words: 60, flip: true };
  assert.deepEqual([...fn!([a, b, c])], [1], 'c overlaps only b, which is hidden, so c stays');
});

test('behind a sheet the plates keep to the pane: the flip and the fit use the pane, not the window (audit 2026-11-17)', () => {
  const { placeInPane } = labels as unknown as {
    placeInPane: (x: number, y: number, words: number, pane: { left: number; right: number; height: number }, margin?: number) => { flip: boolean; fits: boolean };
  };
  assert.equal(typeof placeInPane, 'function');
  const pane = { left: 752, right: 1600, height: 1000 };
  // Sparrow & Co near the window's right edge flips left of its hairline and stays whole.
  assert.deepEqual(placeInPane(1520, 500, 130, pane), { flip: true, fits: true });
  // Just right of the sheet's edge, a plate whose flipped words would run under the sheet does not flip; it shows right.
  assert.deepEqual(placeInPane(800, 500, 120, pane), { flip: false, fits: true });
  // Its foot under the sheet: not in the pane, so not shown (and never in the collision pass).
  assert.equal(placeInPane(700, 500, 120, pane).fits, false);
  // Narrow pane: neither side fits, so the plate waits rather than run under the sheet or off the window.
  assert.equal(placeInPane(820, 500, 200, { left: 760, right: 980, height: 1000 }).fits, false);
  // With no sheet the pane is the window, as before.
  assert.deepEqual(placeInPane(1440, 500, 120, { left: 0, right: 1512, height: 890 }), { flip: true, fits: true });
});

test('the plates read the pane the screens set, and the guard sets it to the open sheet\'s right edge', () => {
  const src = readFileSync(new URL('../app/src/city/labels.ts', import.meta.url), 'utf8');
  assert.match(src, /export function setPlatePane\(/);
  const guard = readFileSync(new URL('../app/src/ui/plate-guard.ts', import.meta.url), 'utf8');
  assert.match(guard, /setPlatePane\(/);
});

type Seen = { x: number; y: number; behind: boolean };
type Project = (at: THREE.Vector3, camera: THREE.Camera, w: number, h: number, out: Seen, scratch?: THREE.Vector3) => Seen;

/** The camera of Task 8's tests: at (0, 0, 10), looking at the origin, its matrices current. */
function eye(): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(50, 1600 / 1000, 1, 5000);
  camera.position.set(0, 0, 10);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  return camera;
}

test("projectToView puts the camera's target at the view's centre", () => {
  const projectToView = (labels as unknown as { projectToView?: Project }).projectToView;
  assert.equal(typeof projectToView, 'function', 'labels.ts shares its projection with the screens');
  const out: Seen = { x: -1, y: -1, behind: true };
  const got = projectToView!(new THREE.Vector3(0, 0, 0), eye(), 1600, 1000, out);
  assert.equal(got, out, 'it writes into the object it is given');
  assert.ok(Math.abs(got.x - 800) < 1e-6, `x ${got.x}`);
  assert.ok(Math.abs(got.y - 500) < 1e-6, `y ${got.y}`);
  assert.equal(got.behind, false);
  // Up in the world is up on the view: a smaller y.
  assert.ok(projectToView!(new THREE.Vector3(0, 1, 0), eye(), 1600, 1000, out).y < 500);
});

test('a point behind the eye is behind', () => {
  const projectToView = (labels as unknown as { projectToView?: Project }).projectToView;
  assert.equal(typeof projectToView, 'function');
  const scratch = new THREE.Vector3();
  assert.equal(projectToView!(new THREE.Vector3(0, 0, 20), eye(), 1600, 1000, { x: 0, y: 0, behind: false }, scratch).behind, true);
});

/** Just enough of a DOM element for createPlates: its style, its classes and its words' width. */
function fakeElement(): Record<string, unknown> {
  return {
    style: {} as Record<string, string>,
    classList: { toggle() {}, add() {}, remove() {} },
    className: '',
    textContent: '',
    title: '',
    disabled: false,
    offsetWidth: 40,
    append() {},
    appendChild() {},
    remove() {},
    addEventListener() {},
    setAttribute() {},
    removeAttribute() {},
  };
}

test('the plates use the shared projection', () => {
  const projectToView = (labels as unknown as { projectToView?: Project }).projectToView;
  assert.equal(typeof projectToView, 'function');
  const g = globalThis as unknown as { document?: unknown };
  const had = g.document;
  const made: Array<Record<string, unknown>> = [];
  g.document = {
    createElement() {
      const el = fakeElement();
      made.push(el);
      return el;
    },
  };
  try {
    const host = { clientWidth: 1600, clientHeight: 1000, appendChild() {} } as unknown as HTMLElement;
    const camera = eye();
    const plates = labels.createPlates(host, camera, () => []);
    const front = new THREE.Vector3(1.5, -2, 0);
    const back = new THREE.Vector3(0, 0, 20);
    plates.set([
      { key: 'front', origin: { x: 0, z: 0 }, name: 'Front', sub: '', at: (o) => o.copy(front) },
      { key: 'back', origin: { x: 0, z: 0 }, name: 'Back', sub: '', at: (o) => o.copy(back) },
    ]);
    // The plates' buttons, in the order set: [layer, button, name, sub, button, name, sub].
    const buttons = made.filter((_, i) => i === 1 || i === 4) as Array<{ style: Record<string, string> }>;
    plates.update();
    const want = projectToView!(front, camera, 1600, 1000, { x: 0, y: 0, behind: true });
    assert.equal(want.behind, false);
    assert.equal(buttons[0].style.transform, `translate3d(${want.x.toFixed(1)}px, ${want.y.toFixed(1)}px, 0)`, 'a plate stands where the shared projection puts it');
    assert.equal(buttons[0].style.visibility, 'visible');
    assert.equal(projectToView!(back, camera, 1600, 1000, { x: 0, y: 0, behind: false }).behind, true);
    assert.equal(buttons[1].style.visibility, 'hidden', 'a plate the shared projection calls behind is not shown');
    plates.dispose();
  } finally {
    g.document = had;
  }
});
