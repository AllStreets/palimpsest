/**
 * The Brief's action contract (screens redesign Task 14), pinned before the
 * Brief is rebuilt: what each action does, and which ones the Brief records
 * as a look(). These decisions teach his master net, so the table is held to
 * main's own code, recorded once into tools/fixtures/brief-actions.json by
 * tools/record-brief-actions.ts, never to itself.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { ACTIONS, EFFECT } from '../app/src/ui/brief-actions.js';
import { LOOKS } from '../shared/brief-actions.js';
import type { BriefAction } from '../shared/types.js';

interface Fixture {
  commit: string;
  actions: string[];
  effect: Record<string, string>;
  uiLooks: string[];
  engineLooks: string[];
}

const main = JSON.parse(readFileSync(new URL('../tools/fixtures/brief-actions.json', import.meta.url), 'utf8')) as Fixture;

const ALL: BriefAction[] = ['accept', 'tier', 'dismiss', 'why', 'diff', 'fly', 'retry', 'resume', 'open-pr', 'cap', 'audit', 'tour', 'grant', 'decline', 'revoke'];

test('every action has an effect', () => {
  assert.equal(ALL.length, 15);
  assert.deepEqual(Object.keys(EFFECT).sort(), [...ALL].sort());
  assert.deepEqual([...main.actions].sort(), [...ALL].sort(), "main's union is the same 15");
  for (const a of ALL) assert.ok(EFFECT[a], a);
});

test("the table is main's", () => {
  assert.match(main.commit, /^[0-9a-f]{40}$/, 'the fixture names the commit it was recorded from');
  assert.deepEqual({ ...EFFECT }, main.effect);
  // One table: EFFECT is read from its rows, never kept beside it.
  for (const a of ALL) assert.equal(ACTIONS[a].effect, EFFECT[a], a);
});

test("looks are the engine's looks", () => {
  assert.deepEqual([...LOOKS], main.engineLooks, "LOOKS is main's engine LOOKS, in its order");
  assert.deepEqual([...LOOKS], ['why', 'diff', 'fly', 'open-pr']);
  assert.deepEqual([...LOOKS].sort(), main.uiLooks, "and exactly the actions main's Brief records with look()");
  // One constant: the engine reads it from shared/, with no copy of its own.
  const engine = readFileSync(new URL('../engine/brief.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(engine, /const LOOKS\b/);
  assert.match(engine, /import \{[^}]*\bLOOKS\b[^}]*\} from '\.\.\/shared\/brief-actions\.js';/);
});

test('the Brief dispatches on the table', () => {
  const ui = readFileSync(new URL('../app/src/ui/brief.ts', import.meta.url), 'utf8');
  assert.match(ui, /switch \(EFFECT\[a\]\)/);
  assert.doesNotMatch(ui, /switch \(a\)/);
});
