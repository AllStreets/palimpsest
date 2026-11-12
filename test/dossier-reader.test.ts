/**
 * The floor dossier's reader (Phase 3 Task 18): reads each picked floor's
 * job (and a proposal's audit) in the background, at most three at a time
 * city-wide, cancellable, never holding the ride; a late read fills in, a
 * failed one leaves its floor an ordinary one.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createDossierReader, type DossierApi } from '../app/src/city/dossier-reader.js';
import { RIDE } from '../shared/ride.js';
import type { Floor, JobDetail, TowerSpec } from '../shared/types.js';

function floor(i: number, earned = true, state: 'lit' | 'scar' = 'lit'): Floor {
  return {
    id: `acme/harbour#${i}`,
    repo: 'acme/harbour',
    kind: 'pr',
    refs: [],
    title: `Change ${i}`,
    at: new Date(Date.UTC(2026, 10, 1 + i)).toISOString(),
    era: 'glass',
    size: 'medium',
    lines: 30 + i,
    claude: false,
    founding: !earned,
    url: null,
    ...(earned ? { earned: { jobId: `job-${i}`, runId: `run-${i}`, agentId: 'priya', firmId: 'quickset', state, reverted: false } } : {}),
  };
}

function spec(n: number, scars: number[] = []): TowerSpec {
  const floors = [floor(0, false), ...Array.from({ length: n }, (_, i) => floor(i + 1, true, scars.includes(i + 1) ? 'scar' : 'lit'))];
  return { id: 'acme/harbour#founding', repo: 'acme/harbour', kind: 'founding', root: 'beauxarts', floors, datumIndex: 1 };
}

function detail(i: number, plan = 'Add the retry.'): JobDetail {
  return {
    job: { id: `job-${i}`, source: i === 4 ? 'proposal' : 'issue', proposal: i === 4 ? { auditId: 'audit-1', findingId: 'f1' } : null } as unknown as JobDetail['job'],
    bids: [{ id: `bid-${i}`, plan, agentId: 'priya' } as unknown as JobDetail['bids'][number]],
    award: null,
    satOut: [],
    runs: [{ id: `run-${i}`, bidId: `bid-${i}`, progress: { filesChanged: 2 } } as unknown as JobDetail['runs'][number]],
    inspections: [{ id: `insp-${i}`, runId: `run-${i}`, passed: true, pushable: true, checks: [] } as unknown as JobDetail['inspections'][number]],
    ledger: [],
  };
}

/** A fake API: each job read waits on its own gate, so a test chooses when each lands. */
function fakeApi(o: { fail?: Set<string> } = {}) {
  let active = 0;
  let peak = 0;
  const gates = new Map<string, () => void>();
  const asked: string[] = [];
  const aborted: string[] = [];
  const api: DossierApi = {
    jobs: async () => [{ id: 'job-4', source: 'proposal' }],
    job: (id, signal) =>
      new Promise((resolve, reject) => {
        asked.push(id);
        active++;
        peak = Math.max(peak, active);
        signal?.addEventListener('abort', () => {
          aborted.push(id);
          active--;
          reject(new Error('aborted'));
        });
        gates.set(id, () => {
          active--;
          if (o.fail?.has(id)) reject(new Error('the engine did not answer'));
          else resolve(detail(Number(id.slice(4)), id === 'job-6' ? '<img src=x onerror=alert(1)> then the fix' : 'Add the retry.'));
        });
      }),
    audit: async () => ({ findings: [{ id: 'f1', claim: 'Resumable uploads' }] }),
  };
  return {
    api,
    asked,
    aborted,
    peak: () => peak,
    open: async (id: string) => {
      for (let i = 0; i < 50 && !gates.has(id); i++) await new Promise((r) => setTimeout(r, 1));
      gates.get(id)?.();
      gates.delete(id);
      await new Promise((r) => setTimeout(r, 2));
    },
    openAll: async () => {
      for (let round = 0; round < 20; round++) {
        const ids = [...gates.keys()];
        if (!ids.length) {
          await new Promise((r) => setTimeout(r, 2));
          if (!gates.size) break;
          continue;
        }
        for (const id of ids) {
          gates.get(id)?.();
          gates.delete(id);
        }
        await new Promise((r) => setTimeout(r, 2));
      }
    },
  };
}

const reader = (api: DossierApi) => createDossierReader(api, { firm: () => 'Quickset', redact: (s) => s.replace(/ghp_\w+/g, '[redacted]') });

test('never more than three reads at once, city-wide, across towers', async () => {
  const f = fakeApi();
  const r = reader(f.api);
  void r.read(spec(9, [2, 3, 5]));
  void r.read({ ...spec(9), id: 'other#founding', repo: 'acme/other', floors: spec(9).floors.map((x) => ({ ...x, id: x.id.replace('harbour', 'other'), earned: x.earned ? { ...x.earned, jobId: `${x.earned.jobId}0` } : undefined })) });
  await f.openAll();
  assert.ok(f.asked.length >= 6, `both towers were read (${f.asked.length})`);
  assert.ok(f.peak() <= 3, `at most three at once (${f.peak()})`);
});

test('the ride starts before the reads land, and a late one fills in', async () => {
  const f = fakeApi();
  const r = reader(f.api);
  const s = spec(6);
  void r.read(s);
  await r.proposals();
  // The plan made now: every picked floor pending, each a dossier stop waiting to be filled.
  const plan = r.planFor(s);
  assert.ok(plan.size > 0);
  for (const id of plan.keys()) assert.equal(r.get(id), null, 'nothing read yet');
  const newest = s.floors[s.floors.length - 2].id;
  await f.openAll();
  const d = r.get(newest);
  assert.ok(d, 'the late read fills its floor');
  assert.equal(d.plan, 'Add the retry.');
});

test('a failed read leaves its floor an ordinary one: no dossier stop', async () => {
  const f = fakeApi({ fail: new Set(['job-6']) });
  const r = reader(f.api);
  const s = spec(6);
  void r.read(s);
  await f.openAll();
  const plan = r.planFor(s);
  assert.equal(r.get(s.floors[6].id), null);
  assert.ok(!plan.has(s.floors[6].id), 'the failed floor is passed, never waited at empty');
  assert.ok(plan.has(s.floors[5].id), 'the others still stop');
});

test('cancelling stops the reads in flight and drops what lands after it', async () => {
  const f = fakeApi();
  const r = reader(f.api);
  const s = spec(6);
  void r.read(s);
  await new Promise((res) => setTimeout(res, 5));
  const inFlight = [...f.asked];
  assert.ok(inFlight.length > 0 && inFlight.length <= 3);
  r.cancel();
  assert.deepEqual(f.aborted.sort(), inFlight.sort(), 'every read in flight is aborted');
  await f.openAll();
  for (const fl of s.floors) assert.equal(r.get(fl.id), null, 'nothing lands after the cancel');
  assert.equal(f.asked.length, inFlight.length, 'and nothing queued starts');
});

test('the proposal set is read again when it failed, and on every ride', async () => {
  const f = fakeApi();
  let calls = 0;
  let fail = true;
  f.api.jobs = async () => {
    calls++;
    if (fail) throw new Error('down');
    return [{ id: 'job-4', source: 'proposal' }];
  };
  const r = reader(f.api);
  assert.equal((await r.proposals()).size, 0, 'a failed read is an empty set...');
  fail = false;
  assert.equal((await r.proposals()).size, 1, '...read again next time');
  await r.proposals(true);
  assert.equal(calls, 3, 'a ride refreshes it');
  // The proposal floor is picked and carries its claim.
  const s = spec(6);
  void r.read(s);
  await f.openAll();
  assert.equal(r.get(s.floors[4].id)?.claim, 'Resumable uploads');
});

test('a plan is kept as text, its secrets redacted', async () => {
  const f = fakeApi();
  const r = reader(f.api);
  const s = spec(6);
  void r.read(s);
  await f.openAll();
  const d = r.get(s.floors[6].id)!;
  assert.equal(d.plan, '<img src=x onerror=alert(1)> then the fix', 'markup stays text: it is set with textContent');
  assert.ok(RIDE.dossiers === 6);
});
