/**
 * The school's fixed rules (Phase 4 Task 1): pure values and functions only,
 * so no home, no db and no clock but the one each test passes.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  AGREE,
  ARENA,
  COMMISSION,
  DISTIL,
  FOLLOWUP_DAYS,
  GATE,
  HELD_OUT,
  inWindow,
  itemKey,
  LORA,
  NET_MIN,
  SEALED_USES,
  SURVIVE_DAYS,
  VOYAGE,
  WORK_KINDS,
  workKind,
} from '../shared/school-rules.js';

/** A local moment today at hh:mm. */
const at = (h: number, m = 0): number => new Date(2026, 10, 12, h, m, 0).getTime();

test('inWindow handles 01:00 to 06:00 and 22:00 to 04:00', () => {
  const night = { from: '01:00', to: '06:00' };
  assert.equal(inWindow(night, at(0, 59)), false);
  assert.equal(inWindow(night, at(1, 0)), true, 'the start is inside');
  assert.equal(inWindow(night, at(3, 30)), true);
  assert.equal(inWindow(night, at(5, 59)), true);
  assert.equal(inWindow(night, at(6, 0)), false, 'the end is outside');
  assert.equal(inWindow(night, at(14, 0)), false);

  // A window that crosses midnight.
  const late = { from: '22:00', to: '04:00' };
  assert.equal(inWindow(late, at(21, 59)), false);
  assert.equal(inWindow(late, at(22, 0)), true);
  assert.equal(inWindow(late, at(23, 59)), true);
  assert.equal(inWindow(late, at(0, 0)), true);
  assert.equal(inWindow(late, at(3, 59)), true);
  assert.equal(inWindow(late, at(4, 0)), false);
  assert.equal(inWindow(late, at(12, 0)), false);
});

test('inWindow fails closed on a window it cannot read, and an empty window is never open', () => {
  for (const w of [{ from: '1am', to: '06:00' }, { from: '01:00', to: '24:00' }, { from: '25:00', to: '06:00' }, { from: '', to: '' }]) {
    assert.equal(inWindow(w, at(3)), false, JSON.stringify(w));
  }
  assert.equal(inWindow({ from: '03:00', to: '03:00' }, at(3)), false);
});

test('the rules hold the values the plan fixes', () => {
  assert.deepEqual(WORK_KINDS, ['propose:harness', 'propose:readme-gap', 'merge:low', 'merge:normal', 'merge:high', 'merge:ui']);
  assert.deepEqual(AGREE, { window: 50, rate: 0.95, repoMin: 10, repoLast: 10, actP: 0.9, quietDays: 30, staleDays: 8 });
  assert.deepEqual(NET_MIN, { train: 30, heldOut: 10 });
  assert.equal(HELD_OUT, 0.2);
  assert.deepEqual(DISTIL, { weight: 0.3, under: 100 });
  assert.deepEqual(GATE, { pollMs: 30_000, minFreeGB: 20, trainNowHours: 3, killGraceMs: 10_000 });
  assert.deepEqual(LORA, { min: 100, iters: 600, saveEvery: 50, layers: 16, batch: 2, lr: 1e-5, maxSeq: 4096, maxFileBytes: 24_000, gb: 4.3 });
  assert.deepEqual(ARENA, { mutants: 120, keepPlanted: 60, keepPast: 40, maxTurns: 24 });
  assert.deepEqual(VOYAGE, { population: 8, generations: 4, concurrency: 1 });
  assert.equal(SEALED_USES, 10);
  assert.deepEqual(COMMISSION, { fee: 120, minBalance: 400, firstRefusalDays: 7 });
  assert.equal(FOLLOWUP_DAYS, 14);
  assert.equal(SURVIVE_DAYS, 30);
});

test('workKind names a proposal by its source and a PR by its design check, else its tier', () => {
  assert.equal(workKind({ source: 'harness', tier: 'low' }, null), 'propose:harness');
  assert.equal(workKind({ source: 'proposal', tier: 'normal' }, null), 'propose:readme-gap');
  // A PR, whatever the job's source: a design check makes it a UI merge.
  assert.equal(workKind({ source: 'harness', tier: 'low' }, { design: null }), 'merge:low');
  assert.equal(workKind({ source: 'issue', tier: 'high' }, { design: { after: 8 } }), 'merge:ui');
  assert.equal(workKind({ source: 'issue', tier: 'normal' }, { design: null }), 'merge:normal');
  // An issue or manual job is never a proposal, so with no inspection it is still its tier's merge.
  assert.equal(workKind({ source: 'manual', tier: 'high' }, null), 'merge:high');
  assert.equal(itemKey('merge:ui', 'job-7'), 'merge:ui:job-7');
  assert.equal(itemKey('propose:harness', 'job-1'), 'propose:harness:job-1');
});
