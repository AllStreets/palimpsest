/**
 * The training gate (Phase 4 ruling 6), read the way macOS 26 says it. The
 * pmset fixtures are captures from his Mac (`g-ac-lowpower`, `custom`,
 * `therm-none`, `batt-ac`) and hand edits of them (`batt-battery`,
 * `g-automatic`, `therm-warning`, `g-nokey`). Every probe goes through a
 * fake runner: no test runs pmset, ioreg or df. Temp home only.
 */
import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import { openDb } from '../engine/db.js';
import { realRunner, setRunner, type Runner } from '../engine/exec.js';
import { paths } from '../engine/home.js';
import { acquire } from '../engine/market/budget.js';
import { getSettings, patchSettings } from '../engine/settings.js';
import {
  gateNow,
  parseBatt,
  parseFreeGB,
  parseIdle,
  parsePowerMode,
  parseTherm,
  resetGateCache,
  startTrainNow,
  stopTrainNow,
} from '../engine/school/gate.js';
import type { SchoolSettings } from '../shared/types.js';
import { addAgent, HOUR, MIN, setUp, tearDown } from './guild-fixtures.js';

const FIX = join(import.meta.dirname, 'fixtures', 'pmset');
const fx = (name: string): string => readFileSync(join(FIX, `${name}.txt`), 'utf8');

/** `ioreg -c IOHIDSystem` as macOS prints the idle time, in nanoseconds. */
function ioreg(minutes: number): string {
  const ns = BigInt(Math.round(minutes * 60)) * 1_000_000_000n;
  return `+-o IOHIDSystem  <class IOHIDSystem, id 0x100000465>\n    | {\n    |   "HIDIdleTime" = ${ns}\n    | }\n`;
}

/** `df -k <home>` with `gb` decimal gigabytes available. */
function df(gb: number): string {
  const kb = Math.round((gb * 1e9) / 1024);
  return `Filesystem   1024-blocks      Used Available Capacity iused      ifree %iused  Mounted on\n/dev/disk3s5   971298980 636638860 ${kb}    68% 7351828 3075972680    0%   /System/Volumes/Data\n`;
}

interface Mac {
  batt: string;
  g: string;
  therm: string;
  idleMin: number;
  freeGB: number;
}

let mac: Mac;
let calls: string[];

/** A healthy Mac on power, in Automatic, cool, idle an hour, with room. */
function healthy(): Mac {
  return { batt: fx('batt-ac'), g: fx('g-automatic'), therm: fx('therm-none'), idleMin: 60, freeGB: 300 };
}

const fakeMac: Runner = async (cmd, args) => {
  const base = cmd.split('/').pop() ?? cmd;
  calls.push(`${base} ${args.join(' ')}`.trim());
  const ok = (stdout: string) => ({ stdout, stderr: '', code: 0 });
  if (base === 'pmset' && args.join(' ') === '-g batt') return ok(mac.batt);
  if (base === 'pmset' && args.join(' ') === '-g therm') return ok(mac.therm);
  if (base === 'pmset' && args.join(' ') === '-g') return ok(mac.g);
  if (base === 'ioreg') return ok(ioreg(mac.idleMin));
  if (base === 'df') return ok(df(mac.freeGB));
  return { stdout: '', stderr: `unexpected ${base}`, code: 1 };
};

function school(p: Partial<SchoolSettings>): void {
  patchSettings({ school: { ...getSettings().school, ...p } });
}

/** 03:00 local on 12 November 2026: inside the default 01:00 to 06:00 window. */
const NIGHT = new Date(2026, 10, 12, 3, 0).getTime();
/** 14:00 local the same day: outside it. */
const DAY = new Date(2026, 10, 12, 14, 0).getTime();

beforeEach(() => {
  setUp('school-gate');
  mac = healthy();
  calls = [];
  resetGateCache();
  setRunner(fakeMac);
  school({ enabled: true });
});

afterEach(async () => {
  setRunner(realRunner);
  resetGateCache();
  await tearDown();
});

async function both(now: number) {
  resetGateCache();
  return { light: await gateNow('light', now), heavy: await gateNow('heavy', now) };
}

test('the captured pmset -g reads power mode 1', () => {
  assert.equal(parsePowerMode(fx('g-ac-lowpower')), 1);
  assert.equal(parsePowerMode(fx('g-automatic')), 0);
  assert.equal(parsePowerMode(fx('g-nokey')), null);
  // The per-source listing has no "Currently in use:" section: its Battery Power 0 is not his mode.
  assert.equal(parsePowerMode(fx('custom')), null);
  assert.equal(parsePowerMode(fx('g-ac-lowpower').replace(/powermode {12}1/, 'powermode            7')), null);
  assert.equal(parseBatt(fx('batt-ac')), 'ac');
  assert.equal(parseBatt(fx('batt-battery')), 'battery');
  assert.equal(parseBatt(''), 'unknown');
  assert.equal(parseIdle(ioreg(16)), 16);
  assert.equal(parseIdle('nothing here'), null);
  assert.equal(Math.round(parseFreeGB(df(19))! * 10) / 10, 19);
  assert.equal(parseFreeGB('Filesystem 1024-blocks\n'), null);
});

test('the captured therm notes read nominal', () => {
  assert.equal(parseTherm(fx('therm-none')), 'nominal');
  assert.equal(parseTherm('Thermal warning level set to 0.\nPerformance warning level set to 0.\n'), 'nominal');
});

test('a warning level of 2 reads limited and an unknown line unknown', () => {
  assert.equal(parseTherm(fx('therm-warning')), 'limited');
  assert.equal(parseTherm(`${fx('therm-none')}CPU_Speed_Limit = 70\n`), 'unknown');
  assert.equal(parseTherm(''), 'unknown');
});

test('a pmset -g without powermode fails the gate with "could not read the power mode"', async () => {
  mac.g = fx('g-nokey');
  const g = await both(NIGHT);
  for (const s of [g.light, g.heavy]) {
    assert.equal(s.ok, false);
    assert.equal(s.reason, 'could not read the power mode');
    assert.equal(s.powerMode, null);
  }
});

test('on AC in Low Power the gate holds with allowLowPower and fails without it', async () => {
  mac.g = fx('g-ac-lowpower');
  let g = await both(NIGHT);
  assert.equal(g.light.ok, false);
  assert.equal(g.light.reason, 'in Low Power mode');
  assert.equal(g.heavy.ok, false);
  assert.equal(g.light.powerMode, 1);
  school({ allowLowPower: true });
  g = await both(NIGHT);
  assert.equal(g.light.ok, true, String(g.light.reason));
  assert.equal(g.heavy.ok, true, String(g.heavy.reason));
  assert.equal(g.light.reason, null);
});

test('on battery it fails with "on battery", and Train now cannot open it', async () => {
  mac.batt = fx('batt-battery');
  let g = await both(DAY);
  assert.equal(g.light.reason, 'on battery');
  assert.equal(g.light.power, 'battery');
  const r = await startTrainNow(DAY);
  assert.deepEqual(r, { ok: false, reason: 'on battery' });
  assert.equal(getSettings().school.trainNowUntil, null);
  g = await both(NIGHT);
  assert.equal(g.light.ok, false);
  assert.equal(g.heavy.reason, 'on battery');
});

test('outside the window it fails, and Train now opens it for 3 hours', async () => {
  mac.idleMin = 0;
  let g = await both(DAY);
  assert.equal(g.light.ok, false);
  assert.equal(g.light.reason, 'outside the training window');
  assert.equal(g.light.inWindow, false);

  const r = await startTrainNow(DAY);
  assert.ok(r.ok);
  const until = new Date(DAY + 3 * HOUR).toISOString();
  assert.equal(r.until, until);
  assert.equal(getSettings().school.trainNowUntil, until);

  g = await both(DAY + HOUR);
  assert.equal(g.light.ok, true, String(g.light.reason));
  assert.equal(g.heavy.ok, true, 'Train now also skips the idle wait');
  assert.equal(g.light.trainNowUntil, until);
  assert.equal(g.light.inWindow, false);

  // It never skips power mode, thermals or disk.
  mac.therm = fx('therm-warning');
  g = await both(DAY + HOUR);
  assert.equal(g.heavy.ok, false);
  mac.therm = fx('therm-none');

  g = await both(DAY + 3 * HOUR + MIN);
  assert.equal(g.light.ok, false);
  assert.equal(g.light.reason, 'outside the training window');
  assert.equal(g.light.trainNowUntil, null);

  await startTrainNow(DAY);
  stopTrainNow();
  assert.equal(getSettings().school.trainNowUntil, null);
  g = await both(DAY + HOUR);
  assert.equal(g.light.ok, false);
});

test('heavy needs 15 idle minutes and light does not', async () => {
  mac.idleMin = 14;
  let g = await both(NIGHT);
  assert.equal(g.light.ok, true, String(g.light.reason));
  assert.equal(g.heavy.ok, false);
  assert.equal(g.heavy.reason, 'the Mac has been idle 14 of 15 minutes');
  assert.equal(g.heavy.idleMin, 14);
  mac.idleMin = 15;
  g = await both(NIGHT);
  assert.equal(g.heavy.ok, true, String(g.heavy.reason));
});

test('limited or unknown thermals fail heavy', async () => {
  mac.therm = fx('therm-warning');
  let g = await both(NIGHT);
  assert.equal(g.light.ok, true, String(g.light.reason));
  assert.equal(g.heavy.ok, false);
  assert.equal(g.heavy.thermal, 'limited');
  assert.equal(g.heavy.reason, 'the Mac is running warm');
  mac.therm = 'something new\n';
  g = await both(NIGHT);
  assert.equal(g.heavy.ok, false);
  assert.equal(g.heavy.thermal, 'unknown');
  assert.equal(g.heavy.reason, 'could not read the thermal state');
});

test('19 GB free fails heavy', async () => {
  mac.freeGB = 19;
  let g = await both(NIGHT);
  assert.equal(g.light.ok, true, String(g.light.reason));
  assert.equal(g.heavy.ok, false);
  assert.equal(g.heavy.reason, 'only 19 GB free, the school needs 20');
  mac.freeGB = 20;
  g = await both(NIGHT);
  assert.equal(g.heavy.ok, true, String(g.heavy.reason));
  assert.ok(calls.some((c) => c.startsWith('df -k ')), 'df reads the data home');
});

test('a live or awarded local job fails both', async () => {
  // A live local run holds the local slot.
  const got = await acquire('ollama:qwen2.5-coder:7b', 'work', 1, { now: NIGHT });
  assert.ok(got.ok);
  let g = await both(NIGHT);
  assert.equal(g.light.reason, 'a local job is running');
  assert.equal(g.heavy.reason, 'a local job is running');
  got.lease.release();
  g = await both(NIGHT);
  assert.equal(g.light.ok, true, String(g.light.reason));

  // An awarded job whose winning bid is local waits for the slot.
  addAgent('loc', 'quickset', 'ollama:qwen2.5-coder:7b');
  addAgent('cla', 'quickset', 'claude:sonnet');
  const award = (jobId: string, bidId: string, agentId: string) => {
    const bid = { id: bidId, jobId, firmId: 'quickset', agentId, plan: 'p', price: 5, confidence: 0.5, calibrated: 0.5, appraisal: null, ev: 1, cost: 1, at: new Date(NIGHT).toISOString() };
    openDb().prepare('INSERT INTO bids (id, job_id, json) VALUES (?, ?, ?)').run(bidId, jobId, JSON.stringify({ round: 'r1', bid }));
    const j = { id: jobId, repo: 'acme/widgets', status: 'awarded', awardedBid: bidId, postedAt: new Date(NIGHT).toISOString() };
    openDb().prepare('INSERT INTO jobs (id, repo, status, json) VALUES (?, ?, ?, ?)').run(jobId, j.repo, j.status, JSON.stringify(j));
  };
  award('job-claude', 'bid-claude', 'cla');
  g = await both(NIGHT);
  assert.equal(g.light.ok, true, 'a Claude award does not hold the Mac');
  award('job-local', 'bid-local', 'loc');
  g = await both(NIGHT);
  assert.equal(g.light.reason, 'a local job is waiting');
  assert.equal(g.heavy.reason, 'a local job is waiting');
});

test('the stop file and school.enabled false fail both', async () => {
  writeFileSync(paths().stop, '');
  let g = await both(NIGHT);
  assert.equal(g.light.reason, 'the city is stopped');
  assert.equal(g.heavy.reason, 'the city is stopped');
  rmSync(paths().stop);
  school({ enabled: false });
  g = await both(NIGHT);
  assert.equal(g.light.reason, 'the school is off');
  assert.equal(g.heavy.reason, 'the school is off');
});

test('probes are cached for 10 seconds', async () => {
  resetGateCache();
  await gateNow('heavy', NIGHT);
  const n = calls.length;
  assert.ok(n >= 5);
  await gateNow('heavy', NIGHT + 1000);
  await gateNow('light', NIGHT + 2000);
  assert.equal(calls.length, n, 'nothing re-read within 10 s');
});

test('concurrent gate reads share one probe call each: the cache holds the reading in flight', async () => {
  resetGateCache();
  await Promise.all([gateNow('heavy', NIGHT), gateNow('light', NIGHT), gateNow('heavy', NIGHT)]);
  for (const probe of ['pmset -g batt', 'pmset -g', 'pmset -g therm', 'ioreg -c IOHIDSystem']) {
    assert.equal(calls.filter((c) => c === probe).length, 1, `${probe} ran ${calls.filter((c) => c === probe).length} times`);
  }
  assert.equal(calls.filter((c) => c.startsWith('df ')).length, 1);
});

test('a failed probe read stands 1 s, not 10: the next gate a second later reads again', async () => {
  resetGateCache();
  const failing: Runner = async (cmd, args) => {
    calls.push(`${cmd.split('/').pop()} ${args.join(' ')}`.trim());
    return { stdout: '', stderr: 'pmset: busy', code: 1 };
  };
  setRunner(failing);
  const realNow = Date.now;
  const t0 = realNow();
  try {
    Date.now = () => t0;
    const first = await gateNow('light', NIGHT);
    assert.equal(first.reason, 'could not read the power source');
    setRunner(fakeMac);
    Date.now = () => t0 + 500;
    assert.equal((await gateNow('light', NIGHT)).reason, 'could not read the power source', 'within 1 s the failure stands');
    Date.now = () => t0 + 1_200;
    const later = await gateNow('light', NIGHT);
    assert.equal(later.ok, true, `a failed read held past 1 s: ${later.reason}`);
    // A good reading still stands its 10 s.
    const n = calls.length;
    Date.now = () => t0 + 9_000;
    await gateNow('light', NIGHT);
    assert.equal(calls.length, n);
  } finally {
    Date.now = realNow;
  }
});

test('parseIdle reads the HIDIdleTime of the IOHIDSystem entry, not the first one printed', () => {
  const minutes = (m: number) => BigInt(m * 60) * 1_000_000_000n;
  const text = [
    '+-o Root  <class IORegistryEntry, id 0x100000100, retain 30>',
    '  +-o IOResources  <class IOResources, id 0x100000110>',
    '    | {',
    `    |   "HIDIdleTime" = ${minutes(2)}`,
    '    | }',
    '    +-o IOHIDSystem  <class IOHIDSystem, id 0x100000465>',
    '      | {',
    '      |   "HIDIdleTimeDelta" = 5',
    `      |   "HIDIdleTime" = ${minutes(40)}`,
    '      | }',
    '      +-o IOHIDUserClient  <class IOHIDUserClient, id 0x100000500>',
    '        | {',
    `        |   "HIDIdleTime" = ${minutes(3)}`,
    '        | }',
  ].join('\n');
  assert.equal(parseIdle(text), 40);
  // No IOHIDSystem entry: nothing to read, whatever else says HIDIdleTime.
  assert.equal(parseIdle(text.replace(/IOHIDSystem/g, 'IOOther')), null);
  // The plain capture the other tests use still reads, and so does a bare property line with no header (the sample's answer).
  assert.equal(parseIdle(ioreg(16)), 16);
  assert.equal(parseIdle(`    | |   "HIDIdleTime" = ${minutes(42)}\n`), 42);
});
