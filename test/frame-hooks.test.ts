/**
 * The city's frame hook (Task 8): what the screens run each frame after the plates, kept apart from the scene so
 * it can be held to its word here. Adding returns the removal, removing twice is harmless, and one hook that throws
 * is logged once and dropped, so it never stops the city's frame or the hooks after it.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { createFrameHooks } from '../app/src/city/frame-hooks.js';

test('a hook runs every frame until its removal, and removing it twice is harmless', () => {
  const hooks = createFrameHooks();
  let n = 0;
  const off = hooks.add(() => n++);
  assert.equal(hooks.size(), 1);
  hooks.run();
  hooks.run();
  assert.equal(n, 2);
  off();
  off();
  assert.equal(hooks.size(), 0);
  hooks.run();
  assert.equal(n, 2);
  // The same function added twice runs once a frame, and one removal takes it off.
  const f = () => n++;
  const a = hooks.add(f);
  hooks.add(f);
  assert.equal(hooks.size(), 1);
  hooks.run();
  assert.equal(n, 3);
  a();
  assert.equal(hooks.size(), 0);
});

test('a hook that throws is logged once and dropped, and the hooks after it still run', () => {
  const logged: unknown[][] = [];
  const hooks = createFrameHooks((...args) => logged.push(args));
  let after = 0;
  hooks.add(() => {
    throw new Error('bad pin');
  });
  hooks.add(() => after++);
  hooks.run();
  hooks.run();
  assert.equal(after, 2, 'the hook after the bad one ran both frames');
  assert.equal(logged.length, 1, 'logged once');
  assert.equal(hooks.size(), 1, 'the bad hook is gone');
});

test('a hook may remove itself or add another while the frame runs', () => {
  const hooks = createFrameHooks();
  const ran: string[] = [];
  const off = hooks.add(() => {
    ran.push('a');
    off();
    hooks.add(() => ran.push('b'));
  });
  hooks.run();
  hooks.run();
  assert.deepEqual(ran, ['a', 'b'], 'a hook added during a frame runs from the next one');
});

test('the city runs its hooks after the plates, and exposes them', () => {
  const scene = readFileSync(new URL('../app/src/city/scene.ts', import.meta.url), 'utf8');
  // scene.ts cannot run in node (WebGL): its order is read from the source.
  assert.match(scene, /plates\.update\(\);\s*peoplePlates\.update\(\);\s*frameHooks\.run\(\);/);
  assert.match(scene, /onFrame\(fn: \(\) => void\): \(\) => void;/);
  assert.match(scene, /frameHooks\(\): number;/);
  assert.match(scene, /districts\(\): string\[\];/);
  const main = readFileSync(new URL('../app/src/main.ts', import.meta.url), 'utf8');
  assert.match(main, /frameHooks: \(\) => city\.frameHooks\(\)/);
});
