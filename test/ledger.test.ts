import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import { entries, record } from '../engine/ledger.js';
import { LEDGER_KINDS, type LedgerKind } from '../shared/ledger-kinds.js';

let tempDir: string;
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.PALIMPSEST_HOME;
  tempDir = mkdtempSync(join(tmpdir(), 'palimpsest-test-'));
  process.env.PALIMPSEST_HOME = tempDir;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.PALIMPSEST_HOME;
  else process.env.PALIMPSEST_HOME = previousHome;
  rmSync(tempDir, { recursive: true, force: true });
});

const PHASE_1: LedgerKind[] = [
  'repo.analyzed',
  'repo.connected',
  'repo.disconnected',
  'repo.error',
  'repo.patched',
  'usage.hook.installed',
  'engine.stopped',
  'engine.resumed',
];

test('record refuses a kind outside LEDGER_KINDS', () => {
  assert.throws(() => record('job.exploded' as LedgerKind, {}), /unknown ledger kind job\.exploded/);
  assert.throws(() => record('' as LedgerKind, {}), /unknown ledger kind/);
  assert.equal(entries().length, 0, 'nothing is written for a refused kind');
});

test('record accepts every Phase 1 kind', () => {
  for (const kind of PHASE_1) record(kind, { kind });
  assert.deepEqual(
    entries().map((e) => e.kind),
    PHASE_1,
  );
});

test('LEDGER_KINDS holds the market kinds and no duplicates', () => {
  for (const kind of ['firm.seeded', 'job.awarded', 'run.ended', 'credits.moved', 'api.key.removed']) {
    assert.ok((LEDGER_KINDS as readonly string[]).includes(kind), kind);
  }
  assert.equal(new Set(LEDGER_KINDS).size, LEDGER_KINDS.length);
});
